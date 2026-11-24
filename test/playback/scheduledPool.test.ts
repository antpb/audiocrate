/**
 * Pure ASL instruments in a scene: a pool of voices, chosen ahead of time and
 * played sample-accurately, plus the pieces that make one sound (the drum's
 * pads reaching its playheads, timed notes in the worklet).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { audio, delay, env, osc } from '../../src/asl/builders';
import { ASLValue } from '../../src/asl/ASLValue';
import { scheduledPoolTarget } from '../../src/playback/scheduledPool';
import { prepareLiveVoices } from '../../src/playback/liveVoices';
import { Track } from '../../src/graph/Track';
import { Bus } from '../../src/graph/Bus';
import { AudioMaterialRegistry } from '../../src/registry/AudioMaterialRegistry';
import { defineCrateVoiceProcessor } from '../../src/renderers/worklet/defineVoiceProcessor';
import { ASL } from '../../src/asl/graph';
import type { VoiceHandle } from '../../src/renderers/WebAudioRenderer';

type Call = { voice: number; kind: 'on' | 'off'; note?: number; when?: number };

function fakeVoices(count: number, calls: Call[]): VoiceHandle[] {
  return Array.from({ length: count }, (_, voice) => ({
    node: { connect() {}, disconnect() {} },
    noteOn: (params: Record<string, number>, when?: number) => calls.push({ voice, kind: 'on', note: params.note, when }),
    noteOff: (when?: number) => calls.push({ voice, kind: 'off', when }),
    allNotesOff: () => {},
    setParam() {},
  })) as unknown as VoiceHandle[];
}

const pad = new AudioMaterial({
  name: 'Pad',
  polyphony: 2,
  graph: ({ note }) => osc({ freq: new ASLValue(note!.node).toFrequency() }).mul(env.dahdsr({ attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.2 })),
});

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('scheduledPoolTarget', () => {
  it('assigns voices in time order however the notes arrive, and times every message', async () => {
    const calls: Call[] = [];
    const target = scheduledPoolTarget(pad, fakeVoices(2, calls), () => 0);
    // Sent out of order, as a plan with two clips on one track can be.
    target.noteOn(64, { velocity: 1, when: 2 });
    target.noteOff(64, { when: 3 });
    target.noteOn(60, { velocity: 1, when: 0 });
    target.noteOff(60, { when: 2.5 });
    target.noteOn(62, { velocity: 1, when: 1 });
    target.noteOff(62, { when: 1.5 });
    expect(calls).toEqual([]); // nothing chosen until the whole play is in
    await flush();
    const ons = calls.filter((c) => c.kind === 'on');
    expect(ons.map((c) => [c.note, c.when])).toEqual([[60, 0], [62, 1], [64, 2]]);
    // 60 holds voice A from 0 to 2.5; 62 takes B; 64 at 2 reuses B (free since 1.5), not A.
    const voiceOf = (note: number) => ons.find((c) => c.note === note)!.voice;
    expect(voiceOf(62)).not.toBe(voiceOf(60));
    expect(voiceOf(64)).toBe(voiceOf(62));
    expect(calls.every((c) => typeof c.when === 'number')).toBe(true);
  });

  it('steals the oldest note when every voice is held, gating it off first', async () => {
    const calls: Call[] = [];
    const target = scheduledPoolTarget(pad, fakeVoices(2, calls), () => 0);
    target.noteOn(60, { when: 0 });
    target.noteOn(62, { when: 0.5 });
    target.noteOn(64, { when: 1 });
    await flush();
    const stolen = calls.findIndex((c) => c.kind === 'on' && c.note === 64);
    expect(calls[stolen - 1]).toEqual({ voice: 0, kind: 'off', when: 1 });
    expect(calls[stolen]!.voice).toBe(0);
  });

  it('frees a repeated note before replaying it at the same instant', async () => {
    const calls: Call[] = [];
    const target = scheduledPoolTarget(pad, fakeVoices(1, calls), () => 0);
    target.noteOn(36, { when: 1 });
    target.noteOff(36, { when: 1 });
    target.noteOn(36, { when: 0 });
    target.noteOff(36, { when: 1 });
    await flush();
    expect(calls.map((c) => `${c.kind}@${c.when}`)).toEqual(['on@0', 'off@1', 'on@1', 'off@1']);
  });
});

describe('prepareLiveVoices with a pure ASL instrument', () => {
  const renderer = (made: Array<{ sends?: boolean }>) => ({
    createVoice: async (_graph: unknown, options?: { sends?: boolean }) => {
      made.push({ sends: options?.sends });
      return fakeVoices(1, [])[0]!;
    },
  });

  it('gives it a pool of `polyphony` voices', async () => {
    const track = new Track({ name: 'keys' });
    track.instrument = pad;
    const made: Array<{ sends?: boolean }> = [];
    const voices = await prepareLiveVoices(renderer(made), [track], new Bus(), {}, new AudioMaterialRegistry());
    const live = voices.tracks.get(track.id)!;
    expect(live.instrument).toBeUndefined();
    expect(live.instrumentPool?.voices).toHaveLength(2);
    expect(live.instrumentPool?.outputs).toHaveLength(2);
    expect(made).toHaveLength(2);
  });

  it('keeps the old single voice when the host pools instruments itself', async () => {
    const track = new Track({ name: 'keys' });
    track.instrument = pad;
    const made: Array<{ sends?: boolean }> = [];
    const voices = await prepareLiveVoices(renderer(made), [track], new Bus(), {}, new AudioMaterialRegistry(), {
      poolInstruments: false,
    });
    const live = voices.tracks.get(track.id)!;
    expect(live.instrumentPool).toBeUndefined();
    expect(live.instrument).toBeDefined();
    expect(made).toHaveLength(1);
  });
});

describe('timed voice notes in the worklet', () => {
  type Processor = {
    port: { onmessage: ((event: { data: unknown }) => void) | null };
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  let Processor: (new (options?: { processorOptions?: unknown }) => Processor) | null = null;

  beforeEach(() => {
    globals.sampleRate = 48000;
    globals.currentTime = 0;
    globals.AudioWorkletProcessor = class {
      port = { onmessage: null, postMessage() {} };
    };
    globals.registerProcessor = (_name: string, cls: unknown) => {
      Processor = cls as typeof Processor;
    };
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('audiocrate.registeredProcessors')];
    defineCrateVoiceProcessor('timed-notes-test');
  });
  afterEach(() => {
    for (const key of ['sampleRate', 'currentTime', 'AudioWorkletProcessor', 'registerProcessor']) delete globals[key];
  });

  it('holds a noteOn with a time until that sample, then starts the note there', () => {
    const graph = ASL.node(() => osc({ freq: 440 }).mul(env.dahdsr({ attack: 0, decay: 0, sustain: 1, release: 0 })));
    const processor = new Processor!({ processorOptions: { graph, seed: 1, params: {} } });
    const at = 64 / 48000; // half way through the first block
    processor.port.onmessage?.({ data: { type: 'noteOn', params: {}, when: at } });
    const out = new Float32Array(128);
    processor.process([[]], [[out, new Float32Array(128)]]);
    expect(out.subarray(0, 64).every((v) => v === 0)).toBe(true);
    expect(out.subarray(65).some((v) => v !== 0)).toBe(true);
  });

  it('lets a held effect rest only once its delay line has drained, and keeps the echo', () => {
    // An echo 0.25 s later, buffer up to 0.5 s: it must keep running through
    // the gap until the echo is out, then rest while nothing arrives.
    const graph = ASL.node(() => delay(audio.input(), { timeSec: 0.25, feedback: 0, mix: 1, maxTimeSec: 0.5 }));
    const processor = new Processor!({ processorOptions: { graph, seed: 1, params: {} } });
    let renders = 0;
    const internal = processor as unknown as { renderRange: (...args: unknown[]) => boolean };
    const original = internal.renderRange.bind(processor);
    internal.renderRange = (...args: unknown[]) => {
      renders++;
      return original(...args);
    };
    processor.port.onmessage?.({ data: { type: 'noteOn', params: {} } }); // an insert's gate, held open
    const blockSec = 128 / 48000;
    const run = (input?: Float32Array) => {
      const out = new Float32Array(128);
      processor.process([input ? [input, input] : []], [[out, new Float32Array(128)]]);
      globals.currentTime = (globals.currentTime as number) + blockSec;
      return out;
    };
    const click = new Float32Array(128);
    click[0] = 1;
    run(click);
    let echoed = false;
    for (let b = 1; b < 200; b++) if (run().some((v) => v !== 0)) echoed = true; // 200 blocks = 0.53 s
    expect(echoed).toBe(true);
    const before = renders;
    for (let b = 0; b < 400; b++) run();
    // Memory is 0.75 s (0.5 + margin), about 281 blocks from the echo: it
    // rests for most of these 400.
    expect(renders - before).toBeLessThan(250);
    renders = 0;
    const back = run(click.map((v) => v * 0.5)); // audio again: it wakes at once
    expect(renders).toBeGreaterThan(0);
    expect(back.every((v) => v === 0)).toBe(true); // the delay's wet only, not yet echoed
  });

  it('idles while its next note is still ahead, then plays it on time', () => {
    // Counted at the render call, since a released voice's output is zero
    // whether it ran or was skipped.
    const graph = ASL.node(() => osc({ freq: 440 }).mul(env.dahdsr({ attack: 0, decay: 0, sustain: 1, release: 0 })));
    const processor = new Processor!({ processorOptions: { graph, seed: 1, params: {} } });
    let renders = 0;
    const internal = processor as unknown as { renderRange: (...args: unknown[]) => boolean };
    const original = internal.renderRange.bind(processor);
    internal.renderRange = (...args: unknown[]) => {
      renders++;
      return original(...args);
    };
    const blockSec = 128 / 48000;
    // A whole song's worth ahead: the note is 100 blocks away.
    processor.port.onmessage?.({ data: { type: 'noteOn', params: {}, when: 100 * blockSec } });
    const run = () => {
      const out = new Float32Array(128);
      processor.process([[]], [[out, new Float32Array(128)]]);
      globals.currentTime = (globals.currentTime as number) + blockSec;
      return out;
    };
    for (let b = 0; b < 99; b++) run();
    expect(renders).toBeLessThan(10); // a few quiet blocks, then idle
    run(); // block 99: nothing due yet
    const at = run(); // block 100: the note lands on its first sample
    expect(at.some((v) => v !== 0)).toBe(true);
  });
});
