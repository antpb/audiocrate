import { describe, expect, it } from 'vitest';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { param } from '../../src/graph/param';
import { kernel, uniform } from '../../src/asl/builders';
import { Track } from '../../src/graph/Track';
import { Clip, type AudioBufferLike } from '../../src/graph/Clip';
import { Time } from '../../src/Time';
import { AudioMaterialRegistry } from '../../src/registry/AudioMaterialRegistry';
import { bakeTrackInserts } from '../../src/playback/bakeInserts';
import { OfflineRenderer } from '../../src/renderers/OfflineRenderer';
import { mapPluginSlot } from '../../src/host/mapPluginSlot';
import { oscillatorMaterial } from '../../src/materials/sources';
import { analyzerMaterial } from '../../src/materials/meters';
import { looperMaterial } from '../../src/materials/time';
import { detectPatchRole, flattenPatch, type PatchDocument } from '../../src/patcher/flattenPatch';
import {
  cratePluginDocument,
  parseCratePlugin,
  pluginFromDocument,
  pluginSubtypeFromId,
  stringifyCratePlugin,
  USER_PLUGIN_MANUFACTURER,
} from '../../src/patcher/cratePlugin';

const SR = 48000;

const gainProto = new AudioMaterial({
  name: 'Gain',
  kind: 'test.gain',
  params: { gain: param.range(0, 4, { default: 1 }) },
  automatable: ['gain'],
  graph: ({ input, params }) => input.mul(params.gain),
});

const oneProto = new AudioMaterial({
  name: 'One',
  kind: 'test.one',
  graph: () => uniform(1),
});

const quietProto = new AudioMaterial({
  name: 'Quiet',
  kind: 'test.quiet',
  cvPolarity: 'unipolar',
  graph: () => uniform(0),
});

const seamProto = new AudioMaterial({
  name: 'Seamed',
  kind: 'test.seamed',
  graph: ({ input }) => kernel.seam('test.slot', input),
});

function resolve(kind: string): AudioMaterial | null {
  if (kind === 'test.gain') return gainProto;
  if (kind === 'test.one') return oneProto;
  if (kind === 'test.quiet') return quietProto;
  if (kind === 'test.seamed') return seamProto;
  if (kind === 'oscillator') return oscillatorMaterial;
  return null;
}

function monoBuffer(samples: number[]): AudioBufferLike {
  const data = Float32Array.from(samples);
  return { sampleRate: SR, length: data.length, numberOfChannels: 1, getChannelData: () => data };
}

function trackWith(materials: AudioMaterial[], samples: number[]): Track {
  const track = new Track({ name: 'T' });
  track.addClip(new Clip({ buffer: monoBuffer(samples) }), { at: Time.seconds(0) });
  for (const material of materials) track.materials.add(material);
  return track;
}

async function bakeOne(track: Track): Promise<Float32Array> {
  const baked = await bakeTrackInserts([track], { registry: new AudioMaterialRegistry() });
  return baked.get(track.clips[0]!.clip.id)!.getChannelData(0) as Float32Array;
}

const seriesPatch: PatchDocument = {
  nodes: [
    { id: 'a', kind: 'test.gain', params: { gain: 0.5 } },
    { id: 'b', kind: 'test.gain', params: { gain: 3 } },
    { id: 'out', kind: 'master' },
  ],
  connections: [
    { source: 'a', sourceOutput: 'audio', target: 'b', targetInput: 'input' },
    { source: 'b', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
  ],
};

describe('flattenPatch', () => {
  it('bakes a flattened insert chain identically to the Materials in series', async () => {
    const flat = flattenPatch(seriesPatch, { resolve });
    const input = [0.1, -0.2, 0.3, -0.4];

    const a = gainProto.duplicate();
    a.setParam('gain', 0.5);
    const b = gainProto.duplicate();
    b.setParam('gain', 3);

    const series = await bakeOne(trackWith([a, b], input));
    const flattened = await bakeOne(trackWith([flat], input));
    expect(Array.from(flattened)).toEqual(Array.from(series));
    expect(flattened[0]).toBeCloseTo(0.1 * 1.5, 5);
  });

  it('publishes namespaced params that still steer the flattened graph', async () => {
    const flat = flattenPatch(seriesPatch, { resolve });
    expect(Object.keys(flat.params).sort()).toEqual(['a_gain', 'b_gain']);
    expect(flat.getParam('a_gain')).toBe(0.5);
    expect(flat.getParam('b_gain')).toBe(3);

    flat.setParam('a_gain', 1);
    const out = await bakeOne(trackWith([flat], [1, 1]));
    expect(out[0]).toBeCloseTo(3, 5);
  });

  it('replaces a CV-fed param with the upstream signal mapped onto its range', async () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'cv', kind: 'test.one' },
        { id: 'g', kind: 'test.gain', params: { gain: 1 } },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'cv', sourceOutput: 'audio', target: 'g', targetInput: 'gain' },
        { source: 'g', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    const flat = flattenPatch(patch, { resolve });
    // The CV-fed param is no longer published; the constant 1 maps onto [0, 4] as 4.
    expect(Object.keys(flat.params)).toEqual([]);
    const out = await bakeOne(trackWith([flat], [1, 0.5]));
    expect(out[0]).toBeCloseTo(4, 5);
    expect(out[1]).toBeCloseTo(2, 5);
  });

  it('maps a unipolar CV of 0 onto the param min, not the bipolar midpoint', async () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'cv', kind: 'test.quiet' },
        { id: 'g', kind: 'test.gain', params: { gain: 1 } },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'cv', sourceOutput: 'cv', target: 'g', targetInput: 'gain' },
        { source: 'g', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    const flat = flattenPatch(patch, { resolve });
    const out = await bakeOne(trackWith([flat], [1, 0.5]));
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0, 5);
  });

  it('routes a Line cable to the hosted insert input and mixes stacked cables', async () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'in', kind: 'line' },
        { id: 'g', kind: 'test.gain', params: { gain: 2 } },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'in', sourceOutput: 'audio', target: 'g', targetInput: 'input' },
        { source: 'g', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
        { source: 'in', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    const flat = flattenPatch(patch, { resolve });
    // input * 2 through the gain, plus the dry line straight into master.
    const out = await bakeOne(trackWith([flat], [1, -1]));
    expect(out[0]).toBeCloseTo(3, 5);
    expect(out[1]).toBeCloseTo(-3, 5);
  });

  it('detects an instrument from a keyboard note cable and keeps inner polyphony', () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'keys', kind: 'keyboard' },
        { id: 'osc', kind: 'oscillator' },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'keys', sourceOutput: 'cv', target: 'osc', targetInput: 'note' },
        { source: 'keys', sourceOutput: 'gate', target: 'osc', targetInput: 'gate' },
        { source: 'osc', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    expect(detectPatchRole(patch)).toBe('instrument');
    const flat = flattenPatch(patch, { resolve });
    expect(flat.polyphony).toBe(oscillatorMaterial.polyphony);

    // The voice note reaches the inner oscillator: two pitches render
    // differently. Defaults merge in the way VoicePool.noteOn does live.
    const at = (note: number) => ({ ...flat.snapshotParams(), note, velocity: 1 });
    const low = OfflineRenderer.render(flat.graph, { duration: 0.02, params: at(48) });
    const high = OfflineRenderer.render(flat.graph, { duration: 0.02, params: at(72) });
    const peak = (buf: Float32Array) => Math.max(...Array.from(buf, Math.abs));
    expect(peak(low.samples)).toBeGreaterThan(0.01);
    expect(peak(high.samples)).toBeGreaterThan(0.01);
    let diff = 0;
    for (let i = 0; i < low.samples.length; i += 1) diff = Math.max(diff, Math.abs(low.samples[i]! - high.samples[i]!));
    expect(diff).toBeGreaterThan(0.01);

    // And the VoicePool contract holds: two held notes occupy two slots.
    flat.attachVoices([
      { noteOn: () => {}, noteOff: () => {}, setParam: () => {} },
      { noteOn: () => {}, noteOff: () => {}, setParam: () => {} },
    ]);
    flat.noteOn(60, { velocity: 1 });
    flat.noteOn(64, { velocity: 1 });
    expect(flat.voices.filter((voice) => voice.held)).toHaveLength(2);
  });

  it('detects an instrument from a MIDI In note cable', () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'in', kind: 'midiin' },
        { id: 'osc', kind: 'oscillator' },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'in', sourceOutput: 'note', target: 'osc', targetInput: 'note' },
        { source: 'in', sourceOutput: 'gate', target: 'osc', targetInput: 'gate' },
        { source: 'osc', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    expect(detectPatchRole(patch)).toBe('instrument');
    const flat = flattenPatch(patch, { resolve });
    expect(flat.polyphony).toBe(oscillatorMaterial.polyphony);
  });

  it('treats MIDI Out as a sink and still flattens the audio path', () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'a', kind: 'test.gain', params: { gain: 0.5 } },
        { id: 'midi', kind: 'midiout' },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'a', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
        { source: 'a', sourceOutput: 'audio', target: 'midi', targetInput: 'note' },
      ],
    };
    const flat = flattenPatch(patch, { resolve });
    expect(Object.keys(flat.params)).toContain('a_gain');
  });

  it('does not treat a MIDI In cable into MIDI Out as an instrument', () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'in', kind: 'midiin' },
        { id: 'midi', kind: 'midiout' },
        { id: 'a', kind: 'test.gain', params: { gain: 1 } },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'in', sourceOutput: 'note', target: 'midi', targetInput: 'note' },
        { source: 'in', sourceOutput: 'gate', target: 'midi', targetInput: 'gate' },
        { source: 'a', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    expect(detectPatchRole(patch)).toBe('insert');
  });

  it('splices analyzer note and peak outlets onto pitch and peak followers', () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'line', kind: 'line' },
        { id: 'an', kind: 'analyzer' },
        { id: 'g', kind: 'test.gain', params: { gain: 1 } },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'line', sourceOutput: 'audio', target: 'an', targetInput: 'input' },
        { source: 'an', sourceOutput: 'audio', target: 'g', targetInput: 'input' },
        { source: 'an', sourceOutput: 'note', target: 'g', targetInput: 'gain' },
        { source: 'g', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    const resolveKind = (kind: string) => {
      if (kind === 'analyzer') return analyzerMaterial;
      return resolve(kind);
    };
    const flat = flattenPatch(patch, { resolve: resolveKind });
    const kinds: string[] = [];
    const fields: string[] = [];
    const walk = (node: {
      kind: string;
      params: Record<string, unknown>;
      inputs: Record<string, { kind: string; params: Record<string, unknown>; inputs: Record<string, never> }>;
      list?: readonly unknown[];
    }): void => {
      kinds.push(node.kind);
      if (node.kind === 'pitch') fields.push(String(node.params.field ?? ''));
      for (const child of Object.values(node.inputs)) walk(child);
      for (const child of node.list ?? []) walk(child as typeof node);
    };
    walk(flat.graph.output as never);
    expect(fields).toContain('midi');
  });

  it('splices looper start onto the same looper box as audio', () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'line', kind: 'line' },
        { id: 'lp', kind: 'looper' },
        { id: 'g', kind: 'test.gain', params: { gain: 1 } },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'line', sourceOutput: 'audio', target: 'lp', targetInput: 'input' },
        { source: 'lp', sourceOutput: 'audio', target: 'g', targetInput: 'input' },
        { source: 'lp', sourceOutput: 'start', target: 'g', targetInput: 'gain' },
        { source: 'g', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    const resolveKind = (kind: string) => (kind === 'looper' ? looperMaterial : resolve(kind));
    const flat = flattenPatch(patch, { resolve: resolveKind });
    const fields: string[] = [];
    const boxes: unknown[] = [];
    const walk = (node: {
      kind: string;
      params: Record<string, unknown>;
      inputs: Record<string, { kind: string; params: Record<string, unknown>; inputs: Record<string, never> }>;
      list?: readonly unknown[];
    }): void => {
      if (node.kind === 'looper') {
        fields.push(String(node.params.field ?? 'audio'));
        boxes.push(node.params.box);
      }
      for (const child of Object.values(node.inputs)) walk(child);
      for (const child of node.list ?? []) walk(child as typeof node);
    };
    walk(flat.graph.output as never);
    expect(fields).toContain('audio');
    expect(fields).toContain('start');
    const unique = new Set(boxes.filter((box) => box != null));
    expect(unique.size).toBe(1);
  });

  it('treats Transport as host I/O and splices transport.* outlets in real units', () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'clock', kind: 'transport', params: { bpm: 90, beatsPerBar: 6, beatUnit: 8 } },
        { id: 'g', kind: 'test.gain', params: { gain: 1 } },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'clock', sourceOutput: 'playing', target: 'g', targetInput: 'gain' },
        { source: 'g', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    const flat = flattenPatch(patch, { resolve });
    expect(Object.keys(flat.params)).not.toContain('clock_bpm');
    expect(Object.keys(flat.params)).not.toContain('g_gain');
    const fields: string[] = [];
    const walk = (node: {
      kind: string;
      params: Record<string, unknown>;
      inputs: Record<string, { kind: string; params: Record<string, unknown>; inputs: Record<string, never> }>;
      list?: readonly unknown[];
    }): void => {
      if (node.kind === 'transport') fields.push(String(node.params.field ?? ''));
      for (const child of Object.values(node.inputs)) walk(child);
      for (const child of node.list ?? []) walk(child as typeof node);
    };
    walk(flat.graph.output as never);
    expect(fields).toContain('playing');
  });

  it('refuses an AudioMaterial that names a kernel slot', () => {
    const patch: PatchDocument = {
      nodes: [
        { id: 'k', kind: 'test.seamed' },
        { id: 'out', kind: 'master' },
      ],
      connections: [{ source: 'k', sourceOutput: 'audio', target: 'out', targetInput: 'input' }],
    };
    expect(() => flattenPatch(patch, { resolve })).toThrow(/kernel/);
  });

  it('refuses a feedback cycle and a patch with no output', () => {
    const cycle: PatchDocument = {
      nodes: [
        { id: 'a', kind: 'test.gain' },
        { id: 'b', kind: 'test.gain' },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'a', sourceOutput: 'audio', target: 'b', targetInput: 'input' },
        { source: 'b', sourceOutput: 'audio', target: 'a', targetInput: 'input' },
        { source: 'b', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    expect(() => flattenPatch(cycle, { resolve })).toThrow(/cycle/);

    const unwired: PatchDocument = {
      nodes: [
        { id: 'a', kind: 'test.gain' },
        { id: 'out', kind: 'master' },
      ],
      connections: [],
    };
    expect(() => flattenPatch(unwired, { resolve })).toThrow(/master/);

    const noMaster: PatchDocument = {
      nodes: [{ id: 'a', kind: 'test.gain' }],
      connections: [],
    };
    expect(() => flattenPatch(noMaster, { resolve })).toThrow(/master/);
  });
});

describe('crate.plugin document', () => {
  it('round-trips through stringify and parse', () => {
    const doc = cratePluginDocument({ label: 'My Chain', role: 'insert', patch: seriesPatch });
    expect(doc.id).toBe('user.my-chain');
    const back = parseCratePlugin(stringifyCratePlugin(doc));
    expect(back).toEqual(doc);
    expect(() => parseCratePlugin('{"kind":"crate.patch"}')).toThrow(/crate.plugin/);
  });

  it('registers, maps a project slot, and applies a JSON preset', () => {
    const doc = cratePluginDocument({ label: 'My Chain', role: 'insert', patch: seriesPatch });
    const plugin = pluginFromDocument(doc, { resolve });
    const registry = new AudioMaterialRegistry().register(plugin);

    const mapped = mapPluginSlot(
      {
        componentType: plugin.host!.componentType!,
        componentSubType: pluginSubtypeFromId(doc.id),
        componentManufacturer: USER_PLUGIN_MANUFACTURER,
      },
      JSON.stringify({ a_gain: 2, bogus: 'no', missing_param: 9 }),
      registry,
    );
    expect(mapped.bound).toBe(true);
    if (!mapped.bound) return;
    expect(mapped.role).toBe('insert');
    expect(mapped.material.getParam('a_gain')).toBe(2);
    expect(mapped.material.getParam('b_gain')).toBe(3);
  });
});
