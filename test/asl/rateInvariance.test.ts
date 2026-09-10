/**
 * Is the interpreter rate correct?
 *
 * ## Why this is not the conformance fixture with a second rate bolted on
 *
 * The conformance fixture compares samples, which works because both sides
 * render the same graph on the same grid. Two rates share no grid: sample `i`
 * at 48 kHz is not the same moment as sample `i` at 44.1, so there is nothing
 * to line up. Resampling one to the other to diff them is worse than useless,
 * because a resampler's own error is the same size as the bug being hunted.
 *
 * ## What these assert instead
 *
 * Each test states a physical quantity the graph is *specified* to produce (a
 * 20 ms attack, a 5 ms delay, a 50 Hz oscillation) and then measures it back
 * out of the rendered audio **at both rates**. The assertion is against the
 * specification, not against the other rate.
 *
 * That is the part that makes this catch things a cross-rate comparison would
 * not. Two rates can agree with each other and both be wrong. A test that
 * measures 20 ms of attack out of a 20 ms attack cannot be wrong in that way.
 *
 * A node that hardcodes 48000, or divides where it should multiply by the
 * rate, is off by 48000/44100, which is 8.8%. The tolerances below are set an
 * order of magnitude tighter than that where the measurement allows, so the
 * gap between "correct" and "the bug" is not a judgement call.
 */
import { describe, expect, it } from 'vitest';
import { ASL } from '../../src/asl/graph';
import { audio, clock, delay, env, filter, lfo, osc, slew, uniform } from '../../src/asl/builders';
import { RATE_A, RATE_B, renderAtRate } from '../../src/asl/rateInvariance';

const RATES = [RATE_A, RATE_B];

/** Seconds at which the signal first reaches `fraction` of its peak. */
function timeToFractionOfPeak(signal: Float32Array, sampleRate: number, fraction: number): number {
  let peak = 0;
  for (const value of signal) peak = Math.max(peak, Math.abs(value));
  if (peak === 0) return 0;
  const target = peak * fraction;
  for (let i = 0; i < signal.length; i++) {
    if (Math.abs(signal[i]!) >= target) return i / sampleRate;
  }
  return signal.length / sampleRate;
}

/** Rising edges above half peak, per second. */
function eventsPerSecond(signal: Float32Array, sampleRate: number): number {
  let peak = 0;
  for (const value of signal) peak = Math.max(peak, Math.abs(value));
  if (peak === 0) return 0;
  const threshold = peak * 0.5;
  let count = 0;
  let above = false;
  for (const value of signal) {
    const now = Math.abs(value) >= threshold;
    if (now && !above) count++;
    above = now;
  }
  return count / (signal.length / sampleRate);
}

/**
 * The lag in seconds of the strongest repeat, searched over a stated range.
 *
 * The range is given in seconds by the caller so both rates examine the same
 * musical interval, and so a test looking for a 5 ms echo does not find a
 * 1 ms one instead.
 */
function repeatLagSec(signal: Float32Array, sampleRate: number, minSec: number, maxSec: number): number {
  const minLag = Math.max(1, Math.floor(minSec * sampleRate));
  const maxLag = Math.min(Math.floor(maxSec * sampleRate), signal.length - 1);
  let best = -Infinity;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < signal.length; i++) sum += signal[i]! * signal[i + lag]!;
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return bestLag / sampleRate;
}

function zeroCrossingsPerSecond(signal: Float32Array, sampleRate: number): number {
  let count = 0;
  let previous = 0;
  let peak = 0;
  for (const value of signal) peak = Math.max(peak, Math.abs(value));
  const deadband = peak * 1e-3;
  for (const value of signal) {
    if (Math.abs(value) <= deadband) continue;
    const sign = Math.sign(value);
    if (previous !== 0 && sign !== previous) count++;
    previous = sign;
  }
  return count / (signal.length / sampleRate);
}

describe('rate correctness', () => {
  it('renders an envelope attack of the length it was given', () => {
    // The specification is 20 ms. A rate bug makes it 21.8 ms at 44.1 kHz,
    // which this tolerance excludes by a factor of four.
    const attack = 0.02;
    const graph = ASL.node(() =>
      osc({ freq: uniform(440) }).mul(env.adsr({ attack, decay: 1, sustain: 1, release: 1 }).trigger(1)),
    );
    for (const rate of RATES) {
      const signal = renderAtRate(graph, false, rate, 0.2);
      const measured = timeToFractionOfPeak(signal, rate, 0.99);
      expect(measured, `attack at ${rate} Hz measured ${(measured * 1000).toFixed(2)} ms`).toBeGreaterThan(
        attack * 0.95,
      );
      expect(measured, `attack at ${rate} Hz measured ${(measured * 1000).toFixed(2)} ms`).toBeLessThan(
        attack * 1.05,
      );
    }
  });

  it('delays by the number of seconds it was given', () => {
    // A delay is where a rate error is most audible and least visible: the
    // signal is unchanged, it just arrives at the wrong time.
    //
    // Driven by a single impulse, not by the usual test tone. That tone's
    // fundamental is 220 Hz, which repeats every 4.545 ms, and looking for a
    // 5 ms echo in it finds the fundamental instead: the first version of
    // this test "measured" 4.558 ms and read as a rate bug in the delay. An
    // impulse has no period to be mistaken for the echo.
    const timeSec = 0.005;
    const graph = ASL.node(() =>
      delay(audio.input(), { timeSec: uniform(timeSec), feedback: uniform(0), mix: uniform(1), maxTimeSec: 0.05 }),
    );
    const oneImpulse = (_rate: number, frames: number) => {
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      left[0] = 1;
      right[0] = 1;
      return { left, right };
    };
    for (const rate of RATES) {
      // Long enough to include the echo and the glide the delay pointer makes
      // toward a new target, which is about 20 ms.
      const signal = renderAtRate(graph, true, rate, 0.1, oneImpulse);
      let peak = 0;
      let peakAt = 0;
      // From one sample in, so the dry impulse at 0 is not the answer.
      for (let i = 1; i < signal.length; i++) {
        if (Math.abs(signal[i]!) > peak) {
          peak = Math.abs(signal[i]!);
          peakAt = i;
        }
      }
      const measured = peakAt / rate;
      expect(peak, `delay at ${rate} Hz produced no echo`).toBeGreaterThan(0.1);
      expect(measured, `delay at ${rate} Hz echoed at ${(measured * 1000).toFixed(3)} ms`).toBeGreaterThan(timeSec * 0.97);
      expect(measured, `delay at ${rate} Hz echoed at ${(measured * 1000).toFixed(3)} ms`).toBeLessThan(timeSec * 1.03);
    }
  });

  it('runs an LFO at the rate it was given', () => {
    // A sine crosses zero twice per cycle, so 50 Hz is 100 crossings a second
    // whatever the sample rate is.
    const hz = 50;
    const graph = ASL.node(() => lfo({ rate: uniform(hz) }));
    for (const rate of RATES) {
      const signal = renderAtRate(graph, false, rate, 1);
      const crossings = zeroCrossingsPerSecond(signal, rate);
      expect(crossings, `lfo at ${rate} Hz measured ${crossings.toFixed(1)} crossings/s`).toBeGreaterThan(hz * 2 * 0.97);
      expect(crossings, `lfo at ${rate} Hz measured ${crossings.toFixed(1)} crossings/s`).toBeLessThan(hz * 2 * 1.03);
    }
  });

  it('ticks a clock at the rate it was given', () => {
    const hz = 60;
    const graph = ASL.node(() => clock({ freq: uniform(hz) }));
    for (const rate of RATES) {
      const signal = renderAtRate(graph, false, rate, 1);
      const events = eventsPerSecond(signal, rate);
      expect(events, `clock at ${rate} Hz measured ${events.toFixed(1)} ticks/s`).toBeGreaterThan(hz * 0.97);
      expect(events, `clock at ${rate} Hz measured ${events.toFixed(1)} ticks/s`).toBeLessThan(hz * 1.03);
    }
  });

  it('oscillates at the frequency it was given', () => {
    const hz = 440;
    const graph = ASL.node(() => osc({ freq: uniform(hz) }));
    for (const rate of RATES) {
      const signal = renderAtRate(graph, false, rate, 0.5);
      const crossings = zeroCrossingsPerSecond(signal, rate);
      expect(crossings, `osc at ${rate} Hz measured ${crossings.toFixed(1)} crossings/s`).toBeGreaterThan(hz * 2 * 0.99);
      expect(crossings, `osc at ${rate} Hz measured ${crossings.toFixed(1)} crossings/s`).toBeLessThan(hz * 2 * 1.01);
    }
  });

  it('gives a one-pole lowpass the time constant its cutoff implies', () => {
    // A one-pole at fc has tau = 1/(2*pi*fc), and a step reaches 63.2% of its
    // final value in exactly tau. That is an analytic target, so this test
    // says what the filter should do rather than what it currently does.
    // 20 Hz, not 200. At 200 Hz tau is 0.8 ms, which is 35 samples, and
    // time-to-63.2% quantised to a whole sample is already worth 3%. A
    // tolerance loose enough for that is loose enough to admit the 8.8% a
    // rate bug costs, and the first version of this test proved exactly that
    // by passing while every other test here failed. A lower cutoff spreads
    // tau over 350 samples so the measurement is worth a tenth of a percent
    // and the tolerance can be set where it belongs.
    const cutoff = 20;
    const tau = 1 / (2 * Math.PI * cutoff);
    const graph = ASL.node(() => filter.onePoleLowpass(uniform(1), { cutoff: uniform(cutoff) }));
    for (const rate of RATES) {
      const signal = renderAtRate(graph, false, rate, 0.2);
      const measured = timeToFractionOfPeak(signal, rate, 0.632);
      const label = `one-pole at ${rate} Hz reached 63.2% in ${(measured * 1000).toFixed(3)} ms, expected ${(tau * 1000).toFixed(3)}`;
      expect(measured, label).toBeGreaterThan(tau * 0.97);
      expect(measured, label).toBeLessThan(tau * 1.03);
    }
  });

  it('slews at the units per second it was given', () => {
    // Rise is in units per second, so climbing from 0 to 1 takes 1/rise
    // seconds.
    //
    // Driven by an audio input that steps from 0 to 1, not by a constant. A
    // `uniform(1)` is already 1 at the first sample, so the slew initialises
    // at its target and never ramps: the first version of this test measured
    // a rise time of 0 ms and read as a broken slew rather than a test with
    // nothing to measure.
    const rise = 40;
    const expectedSec = 1 / rise;
    const graph = ASL.node(() => slew(audio.input(), { rise: uniform(rise), fall: uniform(rise) }));
    const step = (_rate: number, frames: number) => {
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      left.fill(1);
      right.fill(1);
      left[0] = 0;
      right[0] = 0;
      return { left, right };
    };
    for (const rate of RATES) {
      const signal = renderAtRate(graph, true, rate, 0.2, step);
      const measured = timeToFractionOfPeak(signal, rate, 0.99);
      const label = `slew at ${rate} Hz took ${(measured * 1000).toFixed(2)} ms, expected ${(expectedSec * 1000).toFixed(2)}`;
      expect(measured, label).toBeGreaterThan(expectedSec * 0.95);
      expect(measured, label).toBeLessThan(expectedSec * 1.05);
    }
  });
});
