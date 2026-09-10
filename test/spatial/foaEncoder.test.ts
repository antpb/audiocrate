/**
 * The FOA encoder processor, driven directly with the worklet globals stubbed.
 *
 * What this can prove in Node is the arithmetic: that the encoder agrees with
 * `foaGainsFromPoint`, which is the function already checked against the Swift
 * and Kotlin implementations, and that a position moving inside a block is
 * followed sample by sample rather than held. That second one is the whole
 * reason position is an `AudioParam` instead of a message, so it is the test
 * that would catch the design silently regressing to control rate.
 *
 * What only a browser can show is that the node is wired with four output
 * channels and that `SpatialBus` decodes them: `scripts/check-spatial.mjs`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineCrateFoaEncoder } from '../../src/spatial/worklet/defineFoaEncoder';
import { NAMED_POSITIONS, type NamedSpatialPosition } from '../../src/spatial/positions';
import { foaGainsFromPoint } from '../../src/spatial/foa';
import { distanceAttenuation } from '../../src/spatial/distance';

const SR = 48000;
const BLOCK = 128;

type ProcessorClass = new () => {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
};

const globals = globalThis as unknown as Record<string, unknown>;
let registered: ProcessorClass | null = null;
let nameCounter = 0;

beforeEach(() => {
  registered = null;
  globals.sampleRate = SR;
  globals.currentTime = 0;
  globals.AudioWorkletProcessor = class {};
  globals.registerProcessor = (_name: string, cls: unknown) => {
    registered = cls as ProcessorClass;
  };
  // A fresh name each time: registration is idempotent per name, which is what
  // lets `defineCrateVoiceProcessor` call it without a host having to care.
  defineCrateFoaEncoder(`test-foa-${nameCounter++}`);
});

afterEach(() => {
  delete globals.sampleRate;
  delete globals.currentTime;
  delete globals.AudioWorkletProcessor;
  delete globals.registerProcessor;
});

interface RunOptions {
  input?: Float32Array[];
  x?: number | Float32Array;
  y?: number | Float32Array;
  z?: number | Float32Array;
  gain?: number;
  global?: number;
}

/** Runs one block and returns the four output channels, W Y Z X. */
function run(options: RunOptions = {}): { w: Float32Array; y: Float32Array; z: Float32Array; x: Float32Array } {
  if (!registered) throw new Error('processor did not register');
  const processor = new registered();
  const input = options.input ?? [new Float32Array(BLOCK).fill(1)];
  const outputs = [[
    new Float32Array(BLOCK),
    new Float32Array(BLOCK),
    new Float32Array(BLOCK),
    new Float32Array(BLOCK),
  ]];
  const param = (v: number | Float32Array | undefined, fallback: number): Float32Array =>
    v instanceof Float32Array ? v : new Float32Array([v ?? fallback]);
  processor.process([input], outputs, {
    x: param(options.x, 0),
    y: param(options.y, 0),
    z: param(options.z, -1),
    gain: param(options.gain, 1),
    global: new Float32Array([options.global ?? 0]),
    distanceModel: new Float32Array([0]),
  });
  const [w, y, z, x] = outputs[0]!;
  return { w: w!, y: y!, z: z!, x: x! };
}

describe('the FOA encoder agrees with the reference gains', () => {
  const names = Object.keys(NAMED_POSITIONS) as NamedSpatialPosition[];

  it.each(names)('encodes "%s" the way foaGainsFromPoint does', (name) => {
    const p = NAMED_POSITIONS[name];
    const out = run({ x: p.x, y: p.y, z: p.z });
    // The encoder also applies distance attenuation, which the pure gain
    // function does not: "above" sits at 1.044 m, so this is not a no-op.
    const att = distanceAttenuation(Math.hypot(p.x, p.y, p.z));
    const expected = foaGainsFromPoint(p);
    expect(out.w[0]).toBeCloseTo(expected.w * att, 6);
    expect(out.y[0]).toBeCloseTo(expected.y * att, 6);
    expect(out.z[0]).toBeCloseTo(expected.z * att, 6);
    expect(out.x[0]).toBeCloseTo(expected.x * att, 6);
  });

  it('puts a source on the right in +Y and a source in front in +X', () => {
    // Guards the axis labelling, which is the error that produces audio that
    // plays perfectly out of the wrong side of your head.
    const right = run({ x: 1, y: 0, z: 0 });
    expect(right.y[0]).toBeGreaterThan(0.9);
    expect(right.x[0]).toBeCloseTo(0, 6);

    const front = run({ x: 0, y: 0, z: -1 });
    expect(front.x[0]).toBeGreaterThan(0.9);
    expect(front.y[0]).toBeCloseTo(0, 6);

    const above = run({ x: 0, y: 1, z: 0 });
    expect(above.z[0]).toBeGreaterThan(0.9);
  });
});

describe('position is audio rate', () => {
  it('follows a position that moves inside a single block', () => {
    // The point of the whole design. A control-rate implementation would
    // hold one value for all 128 samples and pass every other test here.
    const x = new Float32Array(BLOCK);
    const z = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const angle = (i / BLOCK) * Math.PI * 2;
      x[i] = Math.sin(angle);
      z[i] = -Math.cos(angle);
    }
    const out = run({ x, y: 0, z });

    const distinct = new Set(Array.from(out.y, (v) => v.toFixed(4)));
    expect(distinct.size).toBeGreaterThan(BLOCK / 2);

    // And it is the *right* movement, not merely movement: Y should trace
    // the same sine the position did, since |p| is 1 throughout.
    for (const i of [0, 32, 64, 96]) {
      expect(out.y[i]).toBeCloseTo(Math.sin((i / BLOCK) * Math.PI * 2), 5);
    }
  });

  it('accepts a length-1 param array, which is how a constant arrives', () => {
    const out = run({ x: 1, y: 0, z: 0 });
    expect(out.y[0]).toBeCloseTo(out.y[BLOCK - 1]!, 9);
    expect(out.y[BLOCK - 1]).toBeGreaterThan(0.9);
  });
});

describe('degenerate and special positions', () => {
  it('treats the origin as omnidirectional rather than flipping direction', () => {
    // `foaGainsFromPoint({0,0,0})` returns a front-facing vector because
    // `Math.atan2(0, -0)` is PI. A position sweeping through zero would
    // click. Here it is silent in the directional channels instead.
    const out = run({ x: 0, y: 0, z: 0 });
    expect(out.y[0]).toBe(0);
    expect(out.z[0]).toBe(0);
    expect(out.x[0]).toBe(0);
    expect(Number.isNaN(out.w[0]!)).toBe(false);
    expect(out.w[0]).toBeGreaterThan(0);
  });

  it('sweeps through the origin without a NaN or a sign flip', () => {
    const x = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) x[i] = (i - BLOCK / 2) / (BLOCK / 2);
    const out = run({ x, y: 0, z: 0 });
    for (let i = 0; i < BLOCK; i++) {
      expect(Number.isFinite(out.y[i]!)).toBe(true);
      expect(Number.isFinite(out.w[i]!)).toBe(true);
    }
  });

  it('makes a global source omnidirectional and unattenuated', () => {
    // Global is the DAW's full-width bed. It must not pick up distance
    // attenuation from a position it is ignoring.
    const out = run({ x: 3, y: 2, z: 1, global: 1 });
    expect(out.y[0]).toBe(0);
    expect(out.z[0]).toBe(0);
    expect(out.x[0]).toBe(0);
    expect(out.w[0]).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

describe('input handling', () => {
  it('averages stereo rather than summing it', () => {
    const both = run({ input: [new Float32Array(BLOCK).fill(1), new Float32Array(BLOCK).fill(1)] });
    const mono = run({ input: [new Float32Array(BLOCK).fill(1)] });
    expect(both.w[0]).toBeCloseTo(mono.w[0]!, 9);
  });

  it('is silent with no input connected', () => {
    const out = run({ input: [] });
    expect(out.w.every((v) => v === 0)).toBe(true);
    expect(out.y.every((v) => v === 0)).toBe(true);
  });

  it('scales by gain', () => {
    const half = run({ gain: 0.5 });
    const full = run({ gain: 1 });
    expect(half.w[0]).toBeCloseTo(full.w[0]! * 0.5, 9);
  });
});
