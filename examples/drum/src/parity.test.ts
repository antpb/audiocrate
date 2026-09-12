/**
 * How close the ASL graph gets to `dsp/`, stage by stage.
 *
 * Every bound in here is a measurement, not a target. The point of the
 * exercise was to find out which parts of a 1987 sampler a graph language can
 * state exactly and which parts it can only approach, so a stage that matches
 * to float precision is asserted at float precision and a stage that does not
 * is asserted at the error it actually has, with the reason next to it.
 */
import { describe, expect, it } from 'vitest';
import { ASL, uniform, type ASLGraphDescriptor } from './crate';
import { compileVoice } from '../../../src/asl/compile';
import { bitCrusher026S, bitTrim, cascadeLowpass3, padLowpass } from './drumDsp';
import { BitCrusher } from './reference/BitCrusher';
import { CascadeFilter, CASCADE_LOWPASS } from './reference/CascadeFilter';
import { SVFilter, SVF_LOWPASS } from './reference/SVFilter';
import { bitTrim as refBitTrim, srCurve } from './reference/DrumKernel';

const SR = 48000;
const FRAMES = 2048;

/** Two tones and a ramp: something with transients and something sustained. */
function testSignal(frames = FRAMES): Float32Array {
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / SR;
    const envelope = Math.exp(-t * 6);
    x[i] = (Math.sin(2 * Math.PI * 180 * t) * 0.7 + Math.sin(2 * Math.PI * 2600 * t) * 0.3) * envelope;
  }
  return x;
}

/** Renders an insert graph over one block, with fixed params. */
function renderInsert(graph: ASLGraphDescriptor, params: Record<string, number>, input: Float32Array): Float32Array {
  const voice = compileVoice(graph);
  const state = voice.createState();
  for (const [key, value] of Object.entries(params)) state.params[key] = value;
  voice.noteOn(state, params);
  const out = new Float32Array(input.length);
  voice.renderBlock(state, SR, out, input);
  return out;
}

function maxAbsError(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > worst) worst = d;
  }
  return worst;
}

function referenceCrush(input: Float32Array, bits: number, srate: number): Float32Array {
  const buf = Float32Array.from(input);
  const crusher = new BitCrusher();
  crusher.init();
  crusher.process(buf, buf.length, 1, bits, srCurve(srate, SR));
  const trim = refBitTrim(bits);
  if (trim !== 1) for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * trim;
  return buf;
}

const crushGraph = ASL.node(({ input, bits, srate }) =>
  bitCrusher026S(input, { bits, srate, sampleRate: SR }).mul(bitTrim(bits)),
);

describe('bit crusher', () => {
  it('quantises exactly: the node and the AU round onto the same grid', () => {
    // No sample-rate reduction, so this is the quantiser alone. Float32
    // storage is the only thing between them.
    const input = testSignal();
    const asl = renderInsert(crushGraph, { bits: 12, srate: 1 }, input);
    expect(maxAbsError(asl, referenceCrush(input, 12, 1))).toBeLessThan(1e-6);
  });

  it('truncates exactly in the harsh mode, which is a half-step shift of the same grid', () => {
    const input = testSignal();
    const asl = renderInsert(crushGraph, { bits: 6, srate: 1 }, input);
    expect(maxAbsError(asl, referenceCrush(input, 6, 1))).toBeLessThan(1e-6);
  });

  it('holds exactly in the harsh mode: sampleHold is the AU raw hold', () => {
    // Both are phase accumulators ticking at freq/sampleRate. Passing the
    // hold rate in hertz rather than as a ratio is the whole translation.
    const input = testSignal();
    const asl = renderInsert(crushGraph, { bits: 6, srate: 0.45 }, input);
    expect(maxAbsError(asl, referenceCrush(input, 6, 0.45))).toBeLessThan(1e-6);
  });

  it('cannot reproduce the clean mode hold, which lags a sample and is polyBLEP smoothed', () => {
    // The one stage of the crusher with no ASL expression at all. The
    // correction needs the fractional position of the phase wrap, which is
    // inside the hold node, and a one-sample carry back out of it.
    //
    // Two things separate them, and the numbers say which is which. The AU's
    // BLEP path emits last sample's carry, so it runs a sample behind a plain
    // hold: lining that up drops the error from 0.70 to 0.31. What is left is
    // the smoothing itself. Recorded rather than hidden. This is a real
    // difference in what the two sound like.
    const input = testSignal();
    const asl = renderInsert(crushGraph, { bits: 12, srate: 0.45 }, input);
    const reference = referenceCrush(input, 12, 0.45);
    const aligned = new Float32Array(input.length);
    aligned.set(reference.subarray(1));
    expect(maxAbsError(asl, reference)).toBeGreaterThan(0.5);
    expect(maxAbsError(asl.subarray(0, input.length - 1), aligned.subarray(0, input.length - 1))).toBeLessThan(0.4);
  });

  it('trims below 8 bits the way the AU does', () => {
    expect(refBitTrim(4)).toBeCloseTo(0.75, 12);
    expect(refBitTrim(8)).toBe(1);
    const input = testSignal();
    const asl = renderInsert(crushGraph, { bits: 4, srate: 1 }, input);
    expect(maxAbsError(asl, referenceCrush(input, 4, 1))).toBeLessThan(1e-6);
  });
});

const padFilterGraph = ASL.node(({ input, cut, res }) => padLowpass(input, { cutoff: cut, res }));

describe('per-pad low-pass', () => {
  function referencePadFilter(input: Float32Array, cut: number, res: number): Float32Array {
    const filter = new SVFilter();
    filter.init(SR);
    filter.setType(SVF_LOWPASS);
    filter.setCutoff(cut);
    filter.setResonance(res);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = filter.process(input[i]!);
    return out;
  }

  // Cytomic's SVF and the cookbook biquad are the same bilinear prototype, so
  // what is left is the AU's Pade tan against crate's real one, and the
  // reciprocal used to turn the AU's damping into a Q.
  for (const [cut, res] of [
    [800, 0],
    [3000, 0.3],
    [12000, 0.7],
    [20000, 0],
  ] as const) {
    it(`matches the Cytomic SVF at ${cut} Hz, res ${res}`, () => {
      const input = testSignal();
      const asl = renderInsert(padFilterGraph, { cut, res }, input);
      expect(maxAbsError(asl, referencePadFilter(input, cut, res))).toBeLessThan(2e-3);
    });
  }
});

const masterFilterGraph = ASL.node(({ input, cut, res }) =>
  cascadeLowpass3(input, { cutoff: cut, res, sampleRate: SR }),
);

describe('master cascade, order 3', () => {
  function referenceCascade(input: Float32Array, cut: number, res: number): Float32Array {
    const filter = new CascadeFilter();
    filter.init(SR);
    filter.setOrder(3);
    filter.setType(CASCADE_LOWPASS);
    filter.setCutoff(cut);
    filter.setResonance(res);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = filter.process(input[i]!);
    return out;
  }

  for (const [cut, res] of [
    [2000, 0],
    [8000, 0.25],
    [17000, 0.18],
    [20000, 0],
  ] as const) {
    it(`matches the 1-pole into biquad cascade at ${cut} Hz, res ${res}`, () => {
      const input = testSignal();
      const asl = renderInsert(masterFilterGraph, { cut, res }, input);
      expect(maxAbsError(asl, referenceCascade(input, cut, res))).toBeLessThan(2e-3);
    });
  }

  it('is a bilinear one-pole, not the leaky integrator crate ships', () => {
    // The reason `bilinearOnePoleLowpass` exists. If `onePoleLowpass` were
    // close enough there would be nothing to build.
    const input = testSignal();
    const asl = renderInsert(
      ASL.node(({ input: x, cut }) => cascadeLowpass3(x, { cutoff: cut, res: uniform(0), sampleRate: SR })),
      { cut: 17000 },
      input,
    );
    expect(maxAbsError(asl, referenceCascade(input, 17000, 0))).toBeLessThan(2e-3);
  });
});
