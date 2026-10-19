/**
 * The voice processor's life, block by block: the values it starts with, the
 * blocks it skips while idle, and the end it reaches when disposed.
 *
 * All three were found in the browser, not in a test. A pool voice rendered a
 * block or two with every parameter at zero before its `setParam` messages
 * landed, and a ladder with drive 0 turned that into a NaN it kept forever.
 * Idle pool voices ran their whole graph, reverb included, into silence on
 * every block. And a disposed voice kept returning true from `process`, so it
 * was never released. Real `defineCrateVoiceProcessor`, audio globals stubbed,
 * as in `portableKernel.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineCrateVoiceProcessor } from '../../../src/renderers/worklet/defineVoiceProcessor';
import { ASL } from '../../../src/asl/graph';
import { filter, osc } from '../../../src/asl/builders';

const SR = 48000;
const BLOCK = 128;

type Processor = {
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};
type ProcessorClass = new (options?: { processorOptions?: unknown }) => Processor;

const globals = globalThis as unknown as Record<string, unknown>;
let registered: ProcessorClass | null = null;

beforeEach(() => {
  registered = null;
  globals.sampleRate = SR;
  globals.currentTime = 0;
  globals.AudioWorkletProcessor = class {
    port = { onmessage: null, postMessage() {} };
  };
  globals.registerProcessor = (_name: string, cls: unknown) => {
    registered = cls as ProcessorClass;
  };
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('audiocrate.registeredProcessors')];
  defineCrateVoiceProcessor('voice-lifecycle-test');
});

afterEach(() => {
  delete globals.sampleRate;
  delete globals.currentTime;
  delete globals.AudioWorkletProcessor;
  delete globals.registerProcessor;
});

/** A saw through a driven ladder: the node that went NaN in the browser. */
const laddered = ASL.node(({ freq, drive, gain }) =>
  filter.ladder(osc({ freq: freq!, type: 'saw' }), { cutoff: 900, resonance: 0.5, drive: drive! }).mul(gain!),
);

function block(processor: Processor, input?: Float32Array): { out: Float32Array; alive: boolean } {
  const out = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  const alive = processor.process([input ? [input, input] : []], [[out, right]]);
  globals.currentTime = (globals.currentTime as number) + BLOCK / SR;
  return { out, alive };
}

function send(processor: Processor, data: unknown): void {
  processor.port.onmessage?.({ data });
}

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('a voice starts with its values', () => {
  it('renders its first block with the parameters it was built with, not zeros', () => {
    const processor = new registered!({
      processorOptions: { graph: laddered, seed: 1, params: { freq: 220, drive: 2, gain: 0.5 } },
    });
    send(processor, { type: 'noteOn', params: {} });
    const first = block(processor).out;
    expect(first.every(Number.isFinite)).toBe(true);
    // Real sound in the very first block, which only the starting values give.
    let later = new Float32Array(0);
    for (let i = 0; i < 20; i++) later = block(processor).out;
    expect(peak(later)).toBeGreaterThan(0.01);
  });

  it('a ladder with drive 0 passes its input rather than poisoning itself with 0/0', () => {
    const processor = new registered!({
      processorOptions: { graph: laddered, seed: 1, params: { freq: 220, drive: 0, gain: 0.5 } },
    });
    send(processor, { type: 'noteOn', params: {} });
    for (let i = 0; i < 10; i++) expect(block(processor).out.every(Number.isFinite)).toBe(true);
    // And once the real drive arrives it plays, rather than staying NaN.
    send(processor, { type: 'setParam', name: 'drive', value: 2 });
    let out = new Float32Array(0);
    for (let i = 0; i < 10; i++) out = block(processor).out;
    expect(out.every(Number.isFinite)).toBe(true);
    expect(peak(out)).toBeGreaterThan(0.01);
  });
});

describe('an idle voice', () => {
  const make = () =>
    new registered!({ processorOptions: { graph: laddered, seed: 1, params: { freq: 220, drive: 1, gain: 0.5 } } });

  it('stops rendering once released and silent: a parameter alone does not wake it', () => {
    const processor = make();
    // Never played: gate low from the start, and the graph is silent at gain 0.
    send(processor, { type: 'setParam', name: 'gain', value: 0 });
    for (let i = 0; i < 6; i++) block(processor);
    // This graph would sound at gain 0.5 with no note (nothing in it reads the
    // gate), so zeros here can only mean the block was skipped.
    send(processor, { type: 'setParam', name: 'gain', value: 0.5 });
    const idle = block(processor);
    expect(idle.alive).toBe(true);
    expect(peak(idle.out)).toBe(0);
  });

  it('wakes on a note, on the same block', () => {
    const processor = make();
    send(processor, { type: 'setParam', name: 'gain', value: 0 });
    for (let i = 0; i < 8; i++) block(processor);
    send(processor, { type: 'setParam', name: 'gain', value: 0.5 });
    send(processor, { type: 'noteOn', params: {} });
    let out = new Float32Array(0);
    for (let i = 0; i < 20; i++) out = block(processor).out;
    expect(peak(out)).toBeGreaterThan(0.01);
  });

  it('wakes when audio arrives at its input, so an insert fed later still processes', () => {
    const passthrough = ASL.node(({ input }) => input!);
    const processor = new registered!({ processorOptions: { graph: passthrough, seed: 1 } });
    for (let i = 0; i < 8; i++) block(processor);
    const signal = new Float32Array(BLOCK).fill(0.25);
    expect(peak(block(processor, signal).out)).toBeCloseTo(0.25, 5);
  });

  it('is never skipped while its gate is held, however quiet', () => {
    const processor = make();
    send(processor, { type: 'noteOn', params: {} });
    send(processor, { type: 'setParam', name: 'gain', value: 0 });
    for (let i = 0; i < 8; i++) block(processor);
    send(processor, { type: 'setParam', name: 'gain', value: 0.5 });
    let out = new Float32Array(0);
    for (let i = 0; i < 20; i++) out = block(processor).out;
    expect(peak(out)).toBeGreaterThan(0.01);
  });
});

describe('a disposed voice', () => {
  it('returns false from process, which is what lets the browser free it', () => {
    const processor = new registered!({
      processorOptions: { graph: laddered, seed: 1, params: { freq: 220, drive: 1, gain: 0.5 } },
    });
    expect(block(processor).alive).toBe(true);
    send(processor, { type: 'dispose' });
    expect(block(processor).alive).toBe(false);
  });
});
