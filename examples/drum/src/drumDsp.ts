/**
 * The 026S chain, written in ASL.
 *
 * Each function here is one class out of `dsp/`, expressed as a graph. Where
 * the expression is exact, the comment says which identity makes it exact.
 * Where it is not, the comment says what is missing from the language.
 *
 * Two primitives ASL does not have turn up over and over: dividing by a
 * signal, and any transcendental other than `toFrequency`. Both are recovered
 * here from what does exist. `pow2` rides on `toFrequency`, which is an
 * exponential with the wrong constants folded around it. `reciprocal` is a
 * transfer-curve seed refined by Newton-Raphson, which needs only multiply
 * and add. Neither is a trick for its own sake: without them none of the
 * coefficients below can be computed from a live parameter, and every control
 * on this instrument is live.
 */
import {
  audio,
  bitcrush,
  clip,
  compare,
  delay,
  filter,
  logic,
  panLaw,
  rectify,
  sampleHold,
  select,
  uniform,
  waveshape,
  type ASLValue,
  type ASLValueLike,
} from './crate';

/** 2^x. `toFrequency` is 440 * 2^((n - 69) / 12); this unwraps the constants. */
export function pow2(x: ASLValueLike): ASLValue {
  return uniform(x).mul(12).add(69).toFrequency().mul(1 / 440);
}

/** Samples `fn` onto the grid `waveshape` interpolates over. */
export function transferCurve(fn: (x: number) => number, lo: number, hi: number, points = 257): number[] {
  const curve: number[] = new Array(points);
  for (let i = 0; i < points; i++) curve[i] = fn(lo + ((hi - lo) * i) / (points - 1));
  return curve;
}

/**
 * An arbitrary scalar function of a live value, as a lookup.
 *
 * `waveshape` reads -1..1, so the domain is mapped onto that first. Accuracy
 * is the curve's own: linear interpolation between `points` samples.
 */
export function lookup(x: ASLValue, curve: number[], lo: number, hi: number): ASLValue {
  return waveshape(x.add(-lo).mul(2 / (hi - lo)).add(-1), { curve });
}

/** One Newton-Raphson step toward 1/x from the estimate `y`: y(2 - xy). */
export function reciprocalRefine(x: ASLValue, y: ASLValue): ASLValue {
  return y.mul(x.mul(y).mul(-1).add(2));
}

/**
 * 1/x over a known range, without a divide node.
 *
 * The curve alone lands within a fraction of a percent; each refinement
 * squares the remaining error, so one step is enough for a coefficient and
 * two put it below float precision.
 */
export function reciprocal(x: ASLValue, lo: number, hi: number, steps = 1, points = 257): ASLValue {
  let y = lookup(x, transferCurve((v) => 1 / v, lo, hi, points), lo, hi);
  for (let i = 0; i < steps; i++) y = reciprocalRefine(x, y);
  return y;
}

/**
 * The per-pad low-pass, `dsp/SVFilter.h` at `LowPass`.
 *
 * Cytomic's SVF and the cookbook's biquad are two discretisations of the same
 * analog prototype, 1 / (s^2 + s/Q + 1), both bilinear and both prewarped at
 * the cutoff. They are the same filter written twice: the SVF's damping K is
 * the biquad's 1/Q. So the pad filter is `filter.lowpass` with Q = 1/K, and
 * the only thing left between them is that the AU evaluates tan through a
 * Pade approximant on the audio thread and crate calls the real one. That is
 * about one part in ten thousand of cutoff.
 *
 * `res` is the AU's 0..1 knob, mapped K = 2 - 1.9 * res.
 */
export function padLowpass(input: ASLValue, opts: { cutoff: ASLValue; res: ASLValue }): ASLValue {
  const k = opts.res.mul(-1.9).add(2);
  return filter.lowpass(input, { cutoff: opts.cutoff, q: reciprocal(k, 0.1, 2) });
}

/**
 * tan(w) for w in [0, pi/2), as the Pade [3/3] approximant
 * x(15 - x^2) / (15 - 6x^2).
 *
 * The AU's SVF uses exactly this rather than calling tanf on the audio
 * thread, so for the pad filter it is the faithful choice. `CascadeFilter`
 * calls the real tan, and there is none in ASL, so the master filter's
 * coefficient carries the approximant's error instead: about one part in ten
 * thousand across the cutoff range.
 */
export function fastTan(w: ASLValue): ASLValue {
  const w2 = w.mul(w);
  const numerator = w.mul(w2.mul(-1).add(15));
  const denominator = w2.mul(-6).add(15);
  return numerator.mul(reciprocal(denominator, 0.5, 15, 2));
}

/**
 * The bilinear one-pole low-pass, the first stage of `CascadeFilter` at
 * order 3: y = b0(x + x[-1]) + a*y[-1], with a = (1 - t)/(1 + t) and
 * t = tan(pi*fc/fs).
 *
 * Built rather than called, because crate's `onePoleLowpass` is a leaky
 * integrator (1 - e^-2pi.fc/fs) and this one is a bilinear transform. They
 * part company badly by the time the cutoff is near Nyquist, and this
 * filter's own cutoff sits at 17 kHz.
 *
 * The recursion comes out of `delay`. At one sample of delay the read
 * pointer lands on an integer, so nothing is interpolated, and the node's
 * feedback path is exactly s[n] = x[n] + a*s[n-1]. It returns s[n-1]; s[n]
 * is one multiply-add away and the numerator is the sum of the two.
 *
 * Feedback inside `delay` is clamped to +-0.99, which is the one place this
 * stops being exact: it holds for every cutoff this instrument can reach.
 */
export function bilinearOnePoleLowpass(
  input: ASLValue,
  opts: { cutoff: ASLValue; sampleRate: number },
): ASLValue {
  const t = fastTan(opts.cutoff.mul(Math.PI / opts.sampleRate));
  const a = t.mul(-1).add(1).mul(reciprocal(t.add(1), 1, 20, 2));
  const previous = delay(input, { timeSec: 1 / opts.sampleRate, feedback: a, mix: 1, maxTimeSec: 0.01 });
  const current = input.add(previous.mul(a));
  return current.add(previous).mul(a.mul(-1).add(1).mul(0.5));
}

/**
 * `CascadeFilter` at order 3, low-pass: the bilinear one-pole into one
 * cookbook biquad at q1.
 *
 * The biquad half is exact. `filter.lowpass` is the same cookbook design the
 * AU's `calcLP` writes out by hand, coefficient for coefficient.
 */
export function cascadeLowpass3(
  input: ASLValue,
  opts: { cutoff: ASLValue; res: ASLValue; sampleRate: number },
): ASLValue {
  // Butterworth section Q, pulled toward the user's resonance:
  // userQ = 0.7071 + res * 1.8, q1 = 0.5412 + res * (userQ - 0.5412).
  const userQ = opts.res.mul(1.8).add(0.7071);
  const q1 = opts.res.mul(userQ.add(-0.5412)).add(0.5412);
  const stage1 = bilinearOnePoleLowpass(input, { cutoff: opts.cutoff, sampleRate: opts.sampleRate });
  return filter.lowpass(stage1, { cutoff: opts.cutoff, q: q1 });
}

/**
 * `dsp/BitCrusher.h` with mix pinned at 1, which is how the pad chain calls
 * it.
 *
 * Bit reduction is exact. The native crusher rounds (x/2 + 1/2) * 2^b and
 * maps back, which reduces to rounding x * 2^(b-1) and dividing by it, and
 * that is `bitcrush` as crate defines it: the same node, the same bit count.
 * Truncation, the mode the AU takes at 8 bits and below, is that same
 * rounding shifted half a step down. The only sample the two disagree on is
 * full scale itself, where the AU clamps into the top code and the shifted
 * rounding lands on a tie.
 *
 * Sample-rate reduction is exact in the harsh mode and not in the clean one.
 * `sampleHold` is a phase accumulator ticking at freq/sampleRate, which is
 * what the AU's raw hold is, so passing the hold rate in hertz reproduces it
 * sample for sample. Above 8 bits the AU smooths each hold transition with a
 * polyBLEP correction that carries into the following sample, and there is no
 * way to write that here: the correction needs the fractional position of the
 * wrap, which lives inside the hold, and a one-sample carry back out of it.
 */
export function bitCrusher026S(
  input: ASLValue,
  opts: { bits: ASLValue; srate: ASLValue; sampleRate: number },
): ASLValue {
  const { bits, srate, sampleRate } = opts;

  // One step of the quantiser, 2^-bits, and its reciprocal 2^bits. Shared
  // nodes rather than repeated expressions: the evaluator caches by node, so
  // writing the same arithmetic twice computes it twice.
  const step = pow2(bits.mul(-1));
  const levels = pow2(bits);

  // bits <= 8 is the AU's `harshMode`, where the quantiser truncates instead
  // of rounding. Truncation is the same grid offset by half a step
  // (floor(v) = round(v - 1/2)), so the mode is an offset on the input rather
  // than a second crusher and a choice between them. The offset is a function
  // of the parameters alone, which puts the whole decision at block rate and
  // leaves one node on the audio path.
  const offset = select(uniform(0), step.mul(-1), { which: logic.not(compare(bits, { threshold: 8, mode: 'gt' })) });
  // The quantiser is skipped outright at 16 bits; the reducer below is not.
  const depthActive = compare(bits, { threshold: 15.9, mode: 'lt' });
  const quantised = select(input, bitcrush(input.add(offset), { bits }), { which: depthActive });

  // Hold rate in hertz. The AU curves the knob as (1000/fs)^(1-p) of the
  // engine rate, so in hertz that is 2^(log2 fs - (1-p) log2(fs/1000)).
  const log2Fs = Math.log2(sampleRate);
  const log2Ratio = Math.log2(sampleRate / 1000);
  const holdHz = pow2(srate.mul(log2Ratio).add(log2Fs - log2Ratio));
  const reduced = select(quantised, sampleHold(quantised, { freq: holdHz }), {
    which: compare(srate, { threshold: 0.999, mode: 'lt' }),
  });

  // Noise floor gate: under one quantisation step, fade back toward dry so a
  // decay tail tracks the signal instead of sitting on the LSB.
  const g = clip(rectify(input, { mode: 'full' }).mul(levels), { mode: 'hard' });
  const gated = input.mul(g.mul(-1).add(1)).add(reduced.mul(g));
  return select(reduced, gated, { which: depthActive });
}

/**
 * The output trim the AU applies under 8 bits, where truncation biases
 * negative and long held runs sit near full scale: -2.5 dB at 4 bits,
 * unity at 8.
 */
export function bitTrim(bits: ASLValue): ASLValue {
  const ramp = bits.add(-4).mul(0.25 / 4).add(0.75);
  return select(uniform(1), ramp, { which: compare(bits, { threshold: 8, mode: 'lt' }) });
}

/**
 * Equal-power pan, folded into the mix gain the way the AU folds it.
 *
 * `panLaw` is already the AU's law, angle (pan + 1) * pi/4 with cosine left
 * and sine right. It takes a fixed side, so the rendering channel picks.
 */
export function panned(input: ASLValue, pan: ASLValue): ASLValue {
  return select(panLaw(input, { pan, channel: 'left' }), panLaw(input, { pan, channel: 'right' }), {
    which: audio.lane(),
  });
}
