/**
 * Does a graph sound the same at 44.1 kHz as it does at 48?
 *
 * ## Why the obvious test does not work
 *
 * The conformance fixture renders at one rate and compares sample by sample.
 * That is the right shape for "two implementations agree" and the wrong shape
 * entirely for "one implementation is rate correct", because the two renders
 * do not share a sample grid: 512 frames is 10.67 ms at 48 kHz and 11.61 ms at
 * 44.1, so sample `i` of one is simply not the same moment as sample `i` of
 * the other. There is nothing to line up.
 *
 * Resampling one to the other and diffing is the tempting fix and it is worse
 * than nothing. A resampler's own error is comparable to the error being
 * hunted, so the tolerance has to be loosened until it admits the bug.
 *
 * ## What is compared instead
 *
 * Measurements that are functions of the **signal**, not of the sampling of
 * it. RMS over a fixed span of seconds. Peak. Zero crossings per second.
 * Dominant period in seconds. Time to peak in seconds. Every one of those is
 * the same number for the same sound however it was sampled, so they can be
 * compared across rates directly.
 *
 * That is the whole idea: **compare the physics, not the samples.**
 *
 * ## Why these measurements and not others
 *
 * They are chosen to be sensitive to the actual failure mode. A node that
 * hardcodes 48000, or divides where it should multiply by the rate, does not
 * produce noise: it produces a *correct-looking* signal at the wrong
 * frequency, the wrong time, or the wrong envelope. At 44.1 kHz a coefficient
 * computed against 48000 is off by 8.8%, so:
 *
 *   - a filter's cutoff moves 8.8%, which moves zero crossings per second and
 *     RMS through the filter;
 *   - a delay's time moves 8.8%, which moves the autocorrelation peak;
 *   - an envelope's attack moves 8.8%, which moves time to peak.
 *
 * All three are far outside the few tenths of a percent that different
 * sampling of the same signal costs. The tolerances below are set for that
 * gap, not fitted to whatever the code currently does.
 *
 * ## What is legitimately not rate invariant
 *
 * Some graphs are correctly different at different rates and it would be a
 * bug to make them agree. A delay expressed in samples is a different length
 * of time at a different rate. Anything near Nyquist behaves differently
 * because Nyquist moved. Random sources do not repeat at all.
 *
 * Those are exempted by name with the argument written next to them, the same
 * way `COVERAGE_EXEMPT_KINDS` works, so an exemption is a stated position
 * rather than a silence.
 */
import { compileVoice } from './compile';
import type { ASLGraphDescriptor } from './graph';
import { GOLDEN_PARAMS, GOLDEN_BPM } from './goldenCases';
import type { TransportSnapshot } from './transportNodes';

/** The two rates that actually ship: the DAW's and the phone's. */
export const RATE_A = 44100;
export const RATE_B = 48000;

/**
 * Long enough for the slow things to happen.
 *
 * A 100 ms delay has to come back, an envelope has to reach its peak and
 * start decaying, a 0.02 s phase has to wrap several times. Shorter than this
 * and a rate error in any of them has not had time to become visible.
 */
export const INVARIANCE_SECONDS = 0.5;

/** Fixed block size at both rates, so the block rate differs as it really does. */
export const INVARIANCE_BLOCK = 128;

/**
 * The same input signal as a function of time, at whatever rate is asked for.
 *
 * `goldenInput` cannot be reused: its envelope is a function of frame index,
 * so at a different rate it ramps over a different number of seconds and the
 * two renders would differ for a reason that has nothing to do with the graph.
 * Everything here is a function of `t` in seconds.
 */
export function invarianceInput(sampleRate: number, seconds: number): {
  left: Float32Array;
  right: Float32Array;
} {
  const frames = Math.round(seconds * sampleRate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    // A slow swell rather than a per-frame ramp, so the envelope is the same
    // shape in seconds at both rates.
    const envelope = 0.2 + 0.8 * Math.min(1, t / seconds);
    left[i] = (Math.sin(2 * Math.PI * 220 * t) * 0.6 + Math.sin(2 * Math.PI * 1750 * t) * 0.25) * envelope;
    right[i] =
      (Math.sin(2 * Math.PI * 330 * t) * 0.45 + Math.sin(2 * Math.PI * 990 * t) * 0.3) *
      (1 - 0.7 * Math.min(1, t / seconds));
  }
  return { left, right };
}

function transportAt(seconds: number): TransportSnapshot {
  return {
    beats: (seconds * GOLDEN_BPM) / 60,
    bpm: GOLDEN_BPM,
    playing: true,
    beatsPerBar: 4,
    beatUnit: 4,
  };
}

/** The whole render, at one rate, as one continuous signal. */
export function renderAtRate(
  graph: ASLGraphDescriptor,
  insert: boolean,
  sampleRate: number,
  seconds = INVARIANCE_SECONDS,
  /**
   * A stand-in for the default input, built at the given rate.
   *
   * A measurement is only as good as what it is measuring. Looking for a 5 ms
   * echo in a signal whose own fundamental repeats every 4.5 ms finds the
   * fundamental, and reports a delay that is off by the difference. An
   * impulse has no period to be confused with one.
   */
  makeInput?: (rate: number, frames: number) => { left: Float32Array; right: Float32Array },
): Float32Array {
  const voice = compileVoice(graph);
  const state = voice.createState();
  for (const [key, value] of Object.entries(GOLDEN_PARAMS)) state.params[key] = value;
  voice.noteOn(state, {});

  const frames = Math.round(seconds * sampleRate);
  const { left, right } = makeInput
    ? makeInput(sampleRate, frames)
    : invarianceInput(sampleRate, seconds);
  const total = left.length;
  const out = new Float32Array(total);
  const block = new Float32Array(INVARIANCE_BLOCK);
  const blockR = new Float32Array(INVARIANCE_BLOCK);

  for (let at = 0; at < total; at += INVARIANCE_BLOCK) {
    const n = Math.min(INVARIANCE_BLOCK, total - at);
    const inL = insert ? left.subarray(at, at + n) : undefined;
    const inR = insert ? right.subarray(at, at + n) : undefined;
    const outBlock = n === INVARIANCE_BLOCK ? block : new Float32Array(n);
    const outBlockR = n === INVARIANCE_BLOCK ? blockR : new Float32Array(n);
    voice.renderBlock(state, sampleRate, outBlock, inL, {
      inputR: inR,
      outputR: outBlockR,
      transport: transportAt(at / sampleRate),
    });
    out.set(outBlock.subarray(0, n), at);
  }
  return out;
}

export interface RateMeasurements {
  rms: number;
  peak: number;
  /** Sign changes per second. A cheap, robust proxy for spectral centre. */
  zeroCrossingsPerSecond: number;
  /** Strongest repeat interval in seconds, or 0 when nothing repeats. */
  dominantPeriodSec: number;
  /** When the loudest sample arrives, in seconds. */
  timeToPeakSec: number;
  /** Fraction of total energy in the first half. Catches timing drift. */
  earlyEnergyFraction: number;
}

export function measure(signal: Float32Array, sampleRate: number): RateMeasurements {
  let sumSquares = 0;
  let peak = 0;
  let peakAt = 0;
  let crossings = 0;
  let previous = 0;
  let earlyEnergy = 0;
  const half = Math.floor(signal.length / 2);

  for (let i = 0; i < signal.length; i++) {
    const value = signal[i]!;
    const square = value * value;
    sumSquares += square;
    if (i < half) earlyEnergy += square;
    const magnitude = value < 0 ? -value : value;
    if (magnitude > peak) {
      peak = magnitude;
      peakAt = i;
    }
    // Counted on a sign change with a small deadband, so a signal sitting at
    // zero does not report a crossing on every sample of dither.
    if (magnitude > 1e-4) {
      if (previous !== 0 && Math.sign(value) !== previous) crossings++;
      previous = Math.sign(value);
    }
  }

  const seconds = signal.length / sampleRate;
  return {
    rms: signal.length > 0 ? Math.sqrt(sumSquares / signal.length) : 0,
    peak,
    zeroCrossingsPerSecond: seconds > 0 ? crossings / seconds : 0,
    dominantPeriodSec: dominantPeriodSec(signal, sampleRate),
    timeToPeakSec: peakAt / sampleRate,
    earlyEnergyFraction: sumSquares > 0 ? earlyEnergy / sumSquares : 0,
  };
}

/**
 * Strongest repeat interval, in seconds.
 *
 * Searched over lag in *seconds* rather than in samples so the two rates
 * examine the same range of musical intervals. This is what moves when a
 * delay time or an LFO rate is computed against the wrong sample rate.
 */
function dominantPeriodSec(signal: Float32Array, sampleRate: number): number {
  const minLag = Math.floor(0.0005 * sampleRate);
  const maxLag = Math.min(Math.floor(0.05 * sampleRate), Math.floor(signal.length / 2));
  if (maxLag <= minLag) return 0;
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < signal.length; i += 2) sum += signal[i]! * signal[i + lag]!;
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return best > 0 ? bestLag / sampleRate : 0;
}

/**
 * Allowed disagreement between rates, per measurement, as a fraction.
 *
 * Set against the gap described at the top of this file: a rate bug moves
 * these by about 8.8%, and different sampling of the same signal moves them by
 * a fraction of a percent. Anything in between would be a new kind of problem
 * and should be looked at rather than tuned away.
 */
/**
 * The graphs the analytic rate tests use, as data, so a second implementation
 * can be held to the same physical targets rather than to a second copy of
 * the arithmetic.
 *
 * Each entry is a specification: this graph, driven this way, must measure
 * this quantity. That is deliberately different from the conformance fixture,
 * which records what the reference produced. Here the expected value is what
 * the parameter *says*, so both implementations are checked against the
 * specification and not against each other. Two implementations can agree and
 * both be wrong; neither can measure a 20 ms attack out of a 20 ms attack by
 * accident.
 */
export interface RateSpecCase {
  name: string;
  /** What is being measured, and what it must come out as. */
  quantity: 'attackSec' | 'echoSec' | 'crossingsPerSec' | 'eventsPerSec' | 'tauSec' | 'riseSec';
  expected: number;
  /** Relative tolerance. Every one is far tighter than the 8.8% a rate bug costs. */
  tolerance: number;
  seconds: number;
  /** 'none' renders the graph as a source; the others drive its audio input. */
  input: 'none' | 'impulse' | 'step';
}

export const RATE_SPEC_CASES: readonly RateSpecCase[] = [
  { name: 'adsr attack 20ms', quantity: 'attackSec', expected: 0.02, tolerance: 0.05, seconds: 0.2, input: 'none' },
  { name: 'delay 5ms', quantity: 'echoSec', expected: 0.005, tolerance: 0.03, seconds: 0.1, input: 'impulse' },
  { name: 'lfo 50Hz', quantity: 'crossingsPerSec', expected: 100, tolerance: 0.03, seconds: 1, input: 'none' },
  { name: 'clock 60Hz', quantity: 'eventsPerSec', expected: 60, tolerance: 0.03, seconds: 1, input: 'none' },
  { name: 'osc 440Hz', quantity: 'crossingsPerSec', expected: 880, tolerance: 0.01, seconds: 0.5, input: 'none' },
  { name: 'one pole 20Hz', quantity: 'tauSec', expected: 1 / (2 * Math.PI * 20), tolerance: 0.03, seconds: 0.2, input: 'none' },
  { name: 'slew 40 per sec', quantity: 'riseSec', expected: 1 / 40, tolerance: 0.05, seconds: 0.2, input: 'step' },
];

export const RATE_TOLERANCE: Record<keyof RateMeasurements, number> = {
  rms: 0.02,
  peak: 0.05,
  zeroCrossingsPerSecond: 0.03,
  // A period is quantised to a whole sample, and one sample is 0.2% of a
  // 10 ms period, so this is looser than the others by construction.
  dominantPeriodSec: 0.04,
  // Time to peak on a signal with a flat top can legitimately land on a
  // different sample; loose enough for that and far tighter than 8.8%.
  timeToPeakSec: 0.05,
  earlyEnergyFraction: 0.02,
};
