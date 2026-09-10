import { describe, expect, it } from 'vitest';
import { bakeTrackInserts } from '../../src/playback/bakeInserts';
import { Track } from '../../src/graph/Track';
import { Clip, type AudioBufferLike } from '../../src/graph/Clip';
import { Time } from '../../src/Time';
import { Material } from '../../src/graph/Material';
import { param } from '../../src/graph/param';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry';
import { fuzzPlugin, createFuzzMaterial } from '../../src/testing/testPlugin';
import type { MaterialPlugin } from '../../src/registry/MaterialPlugin';

const SR = 48000;

function monoBuffer(samples: number[]): AudioBufferLike {
  const data = Float32Array.from(samples);
  return { sampleRate: SR, length: data.length, numberOfChannels: 1, getChannelData: () => data };
}

function stereoBuffer(left: number[], right: number[]): AudioBufferLike {
  const l = Float32Array.from(left);
  const r = Float32Array.from(right);
  return { sampleRate: SR, length: l.length, numberOfChannels: 2, getChannelData: (ch) => (ch === 0 ? l : r) };
}

function trackWithClip(buffer: AudioBufferLike): Track {
  const track = new Track({ name: 'T' });
  track.addClip(new Clip({ buffer }), { at: Time.seconds(0) });
  return track;
}

describe('bakeTrackInserts', () => {
  it('returns nothing for a track with no materials', async () => {
    const track = trackWithClip(monoBuffer([0.1, 0.2, 0.3]));
    const baked = await bakeTrackInserts([track]);
    expect(baked.size).toBe(0);
  });

  it('runs a Material with no registered plugin through its plain ASL graph', async () => {
    // The pure-ASL case: no plugin, no kernels, nothing registered. This has to
    // keep working, because a Material that is only a graph is the simplest
    // thing crate supports and needs no registration at all.
    const gain = new Material({
      name: 'Unity',
      params: { gain: param.range(0, 4, { default: 2 }) },
      graph: ({ input, params }) => input.mul(params.gain),
    });
    const track = trackWithClip(monoBuffer([0.1, -0.2, 0.3, -0.4]));
    track.materials.add(gain);

    const baked = await bakeTrackInserts([track], { registry: new MaterialRegistry() });
    const data = baked.get(track.clips[0]!.clip.id)!.getChannelData(0);
    expect(Array.from(data)).toEqual([0.1, -0.2, 0.3, -0.4].map((s) => expect.closeTo(s * 2, 4)));
  });

  it('chains multiple Materials in declared order', async () => {
    const half = new Material({
      name: 'Half',
      params: { gain: param.range(0, 4, { default: 0.5 }) },
      graph: ({ input, params }) => input.mul(params.gain),
    });
    const triple = new Material({
      name: 'Triple',
      params: { gain: param.range(0, 4, { default: 3 }) },
      graph: ({ input, params }) => input.mul(params.gain),
    });
    const track = trackWithClip(monoBuffer([1, 1, 1, 1]));
    track.materials.add(half);
    track.materials.add(triple);

    const baked = await bakeTrackInserts([track], { registry: new MaterialRegistry() });
    const data = baked.get(track.clips[0]!.clip.id)!.getChannelData(0);
    for (const sample of data) expect(sample).toBeCloseTo(1.5, 4);
  });

  it('hands a joint-mode plugin every channel at once, and a per-channel one each separately', async () => {
    // The distinction crate cannot infer: whether a Material's stereo behavior
    // is one decision (mono-summing, channel linking) or two independent ones.
    const jointCalls: number[] = [];
    const perChannelCalls: number[] = [];

    const joint: MaterialPlugin = {
      ...fuzzPlugin,
      kind: 'test.joint',
      bakeMode: 'joint',
      create: () => new Material({ name: 'Joint', kind: 'test.joint', graph: ({ input }) => input }),
      async bake(_material, channels) {
        jointCalls.push(channels.length);
        // Sum to mono and broadcast, the way a mono-summing amp does.
        const summed = Float32Array.from(channels[0]!, (v, i) => (v + (channels[1]?.[i] ?? 0)) / 2);
        return channels.map(() => summed);
      },
    };
    const perChannel: MaterialPlugin = {
      ...fuzzPlugin,
      kind: 'test.perChannel',
      bakeMode: 'per-channel',
      create: () => new Material({ name: 'Per', kind: 'test.perChannel', graph: ({ input }) => input }),
      async bake(_material, channels) {
        perChannelCalls.push(channels.length);
        return channels.map((c) => Float32Array.from(c, (v) => v * 2));
      },
    };
    const registry = new MaterialRegistry().registerAll([joint, perChannel]);

    const track = trackWithClip(stereoBuffer([1, 1], [0, 0]));
    track.materials.add(joint.create());
    track.materials.add(perChannel.create());

    const baked = await bakeTrackInserts([track], { registry });
    const out = baked.get(track.clips[0]!.clip.id)!;

    expect(jointCalls).toEqual([2]); // once, with both channels
    expect(perChannelCalls).toEqual([1, 1]); // twice, one channel each
    expect(Array.from(out.getChannelData(0))).toEqual([1, 1]); // summed 0.5, then doubled
    expect(Array.from(out.getChannelData(1))).toEqual([1, 1]);
  });

  it('forwards the host\'s kernel binaries to the plugin doing the bake', async () => {
    let seen: unknown = null;
    const probe: MaterialPlugin = {
      ...fuzzPlugin,
      kind: 'test.probe',
      bakeMode: 'joint',
      create: createFuzzMaterial,
      async bake(_m, channels, _sr, binaries) {
        seen = binaries['test.fuzz'];
        return [...channels];
      },
    };
    // The Material's kind is what the registry matches, so register the probe
    // under the kind `createFuzzMaterial` actually stamps.
    const registry = new MaterialRegistry().register({ ...probe, kind: 'test.fuzz' });
    const track = trackWithClip(monoBuffer([1]));
    track.materials.add(createFuzzMaterial());

    const bytes = new ArrayBuffer(8);
    await bakeTrackInserts([track], { registry, binaries: { 'test.fuzz': bytes } });
    expect(seen).toBe(bytes);
  });

  it('reuses a host-cached buffer and remembers a freshly baked one', async () => {
    let bakeCalls = 0;
    const probe: MaterialPlugin = {
      ...fuzzPlugin,
      kind: 'test.cache',
      bakeMode: 'joint',
      create: () => new Material({ name: 'Cache', kind: 'test.cache', graph: ({ input }) => input }),
      async bake(_m, channels) {
        bakeCalls += 1;
        return channels.map((c) => Float32Array.from(c, (v) => v * 3));
      },
    };
    const registry = new MaterialRegistry().register(probe);
    const track = trackWithClip(monoBuffer([1, 2]));
    track.materials.add(probe.create());
    const remembered: AudioBufferLike[] = [];
    const progress: Array<{ done: number; total: number; reused: boolean }> = [];

    const first = await bakeTrackInserts([track], {
      registry,
      remember: (_t, _c, wet) => remembered.push(wet),
      onClip: (info) => {
        progress.push(info);
      },
    });
    expect(bakeCalls).toBe(1);
    expect(remembered).toHaveLength(1);
    expect(Array.from(first.get(track.clips[0]!.clip.id)!.getChannelData(0))).toEqual([3, 6]);

    const second = await bakeTrackInserts([track], {
      registry,
      reuse: () => remembered[0],
      onClip: (info) => {
        progress.push(info);
      },
    });
    expect(bakeCalls).toBe(1);
    expect(second.get(track.clips[0]!.clip.id)).toBe(remembered[0]);
    expect(progress).toEqual([
      { done: 1, total: 1, reused: false },
      { done: 1, total: 1, reused: true },
    ]);
  });

  it('skipUncached leaves a miss dry instead of baking on this thread', async () => {
    let bakeCalls = 0;
    const probe: MaterialPlugin = {
      ...fuzzPlugin,
      kind: 'test.skip',
      bakeMode: 'joint',
      create: () => new Material({ name: 'Skip', kind: 'test.skip', graph: ({ input }) => input }),
      async bake(_m, channels) {
        bakeCalls += 1;
        return channels.map((c) => Float32Array.from(c, (v) => v * 9));
      },
    };
    const registry = new MaterialRegistry().register(probe);
    const track = trackWithClip(monoBuffer([1]));
    track.materials.add(probe.create());

    const baked = await bakeTrackInserts([track], { registry, reuse: () => undefined, skipUncached: true });
    expect(bakeCalls).toBe(0);
    expect(baked.size).toBe(0);
  });
});
