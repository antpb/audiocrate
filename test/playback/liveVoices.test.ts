import { describe, expect, it } from 'vitest';
import { prepareLiveVoices, disposeLiveVoices, type LiveVoiceRenderer } from '../../src/playback/liveVoices';
import { Track } from '../../src/graph/Track';
import { Bus } from '../../src/graph/Bus';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { param } from '../../src/graph/param';
import { AudioMaterialRegistry } from '../../src/registry/AudioMaterialRegistry';
import {
  FUZZ_ASSET_KEY,
  FUZZ_KERNEL_SLOT,
  TONE_KERNEL_SLOT,
  createFuzzMaterial,
  createToneMaterial,
  fuzzPlugin,
  tonePlugin,
} from '../../src/testing/testPlugin';
import type { VoiceHandle } from '../../src/renderers/WebAudioRenderer';
import { fakeVoiceHandle } from '../../src/testing/fakeVoice';

interface VoiceCalls {
  noteOnParams?: Record<string, number>;
  kernels: Array<{ slot: string; payload: unknown }>;
  messages: Array<{ slot: string; message: unknown }>;
  disconnected?: boolean;
}

function fakeRenderer(): { renderer: LiveVoiceRenderer; calls: VoiceCalls[] } {
  const calls: VoiceCalls[] = [];
  const renderer: LiveVoiceRenderer = {
    async createVoice() {
      const call: VoiceCalls = { kernels: [], messages: [] };
      calls.push(call);
      const handle: VoiceHandle = fakeVoiceHandle(
        { connect() {}, disconnect: () => void (call.disconnected = true) } as unknown as AudioWorkletNode,
        {
          noteOn: (params) => (call.noteOnParams = params),
          loadKernel: async (slot, payload) => void call.kernels.push({ slot, payload }),
          sendKernel: (slot, message) => void call.messages.push({ slot, message }),
        },
      );
      return handle;
    },
  };
  return { renderer, calls };
}

const registry = new AudioMaterialRegistry().registerAll([fuzzPlugin, tonePlugin]);

describe('prepareLiveVoices', () => {
  it('creates one voice per insert and hands each to its own plugin to bind', async () => {
    const fuzz = createFuzzMaterial();
    fuzz.setAsset(FUZZ_ASSET_KEY, {
      filename: 'curve.wav',
      samples: Float32Array.from([1, 0]),
      sampleRate: 48000,
    });
    const plain = new AudioMaterial({
      name: 'Plain',
      params: { gain: param.range(0, 2, { default: 1 }) },
      graph: ({ input, params }) => input.mul(params.gain),
    });

    const track = new Track({ name: 'T' });
    track.materials.add(fuzz);
    track.materials.add(plain);

    const { renderer, calls } = fakeRenderer();
    const wasm = new ArrayBuffer(1);
    const voices = await prepareLiveVoices(renderer, [track], new Bus({ name: 'Master' }), {
      [FUZZ_KERNEL_SLOT]: wasm,
    }, registry);

    expect(voices.tracks.get(track.id)!.inserts).toHaveLength(2);
    expect(calls).toHaveLength(2);

    expect(calls[0]!.noteOnParams).toEqual(fuzz.snapshotParams());
    expect(calls[0]!.kernels).toEqual([{ slot: FUZZ_KERNEL_SLOT, payload: { wasm } }]);
    expect(calls[0]!.messages[0]).toEqual({
      slot: FUZZ_KERNEL_SLOT,
      message: { type: 'setCurve', samples: Float32Array.from([1, 0]) },
    });

    // An AudioMaterial with no registered plugin is a complete AudioMaterial. It gets a
    // working voice running its ASL graph and nothing else happens to it.
    expect(calls[1]!.noteOnParams).toEqual(plain.snapshotParams());
    expect(calls[1]!.kernels).toEqual([]);
  });

  it('creates a single instrument voice for track.instrument, distinct from the insert chain', async () => {
    const track = new Track({ name: 'T' });
    track.materials.add(createFuzzMaterial());
    track.instrument = createToneMaterial();

    const { renderer, calls } = fakeRenderer();
    const voices = await prepareLiveVoices(renderer, [track], new Bus({ name: 'Master' }), {}, registry);

    expect(voices.tracks.get(track.id)!.inserts).toHaveLength(1);
    expect(voices.tracks.get(track.id)!.instrument).toBeDefined();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.kernels).toEqual([{ slot: TONE_KERNEL_SLOT, payload: {} }]);
  });

  it('binds master inserts too', async () => {
    const master = new Bus({ name: 'Master' });
    master.materials.add(createFuzzMaterial());

    const { renderer, calls } = fakeRenderer();
    const voices = await prepareLiveVoices(renderer, [], master, {}, registry);

    expect(voices.master).toHaveLength(1);
    expect(calls[0]!.kernels[0]!.slot).toBe(FUZZ_KERNEL_SLOT);
  });

  it('still builds a voice when the host supplied no binaries at all', async () => {
    // A plugin decides for itself whether a missing binary is fatal. Crate does
    // not skip the bind, because a partly-loaded plugin is often still useful.
    const track = new Track({ name: 'T' });
    track.materials.add(createFuzzMaterial());

    const { renderer, calls } = fakeRenderer();
    const voices = await prepareLiveVoices(renderer, [track], new Bus({ name: 'Master' }), {}, registry);

    expect(voices.tracks.get(track.id)!.inserts).toHaveLength(1);
    expect(calls[0]!.kernels).toEqual([{ slot: FUZZ_KERNEL_SLOT, payload: { wasm: undefined } }]);
  });

  it('creates master, insert, and instrument voices for one scene', async () => {
    const track = new Track({ name: 'T' });
    track.materials.add(createFuzzMaterial());
    track.instrument = createToneMaterial();
    const master = new Bus({ name: 'Master' });
    master.materials.add(createFuzzMaterial());

    const { renderer, calls } = fakeRenderer();
    await prepareLiveVoices(renderer, [track], master, {}, registry);

    expect(calls).toHaveLength(3); // master insert + track insert + track instrument
  });

  it('disposeLiveVoices disconnects every voice it created', async () => {
    const track = new Track({ name: 'T' });
    track.materials.add(createFuzzMaterial());
    track.instrument = createToneMaterial();

    const { renderer, calls } = fakeRenderer();
    const voices = await prepareLiveVoices(renderer, [track], new Bus({ name: 'Master' }), {}, registry);
    disposeLiveVoices(voices);

    expect(calls.every((c) => c.disconnected)).toBe(true);
  });
});
