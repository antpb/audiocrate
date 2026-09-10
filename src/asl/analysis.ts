/**
 * Measurements coming back out of the audio thread.
 *
 * Every other channel in crate points inward. Params, notes, kernel payloads
 * and messages all travel from the host into the renderer; `onMessage`
 * answers one reply per question and `describe()` fires once at load. Nothing
 * streamed anything back. That single gap is why there is no meter, no
 * spectrum, no tuner and no loudness reading anywhere in the framework, and
 * those are not four features, they are one missing direction.
 *
 * A **tap** is a passthrough node that records what went by. It does not
 * change the signal, so it can sit anywhere in a graph without being a
 * decision about the sound:
 *
 * - `tap.meter(x)` keeps peak and RMS for the interval since the last read.
 *   Cheap enough to leave on: two arithmetic operations per sample.
 * - `tap.capture(x, { windowSize })` keeps the last N samples in a ring
 *   buffer. That is all the audio thread does; the FFT, the YIN pitch track
 *   and the K-weighted loudness all run on the main thread from the captured
 *   window, because running YIN at 30 Hz on a 2048-sample window is tens of
 *   millions of operations a second and the audio thread is the one place
 *   that must never do that.
 *
 * The renderer drains taps on an interval the host asks for
 * (`VoiceHandle.setAnalysisInterval`), and **the default is off**. A tap in a
 * graph nobody is reading costs the two operations and nothing else: no
 * message traffic, no allocation, no main-thread wakeups. Metering every
 * voice at block rate would be 375 messages a second each, which is how
 * analysis usually becomes the most expensive thing in an audio app.
 */
import { ASLValue, type ASLValueLike, toNode } from './ASLValue';
import { makeNode } from './types';

/** Default window a capture tap keeps. Enough for a pitch track at 48 kHz. */
export const DEFAULT_CAPTURE_WINDOW = 2048;

export const tap = {
  /**
   * Records peak and RMS of whatever passes through, under `id`. Returns the
   * input unchanged.
   */
  meter(input: ASLValueLike, opts: { id?: string } = {}): ASLValue {
    return new ASLValue(makeNode('meter', { input: toNode(input) }, { id: opts.id ?? 'meter' }));
  },

  /**
   * Keeps the last `windowSize` samples under `id`, for analysis that needs a
   * window rather than a number. Returns the input unchanged.
   */
  capture(input: ASLValueLike, opts: { id?: string; windowSize?: number } = {}): ASLValue {
    return new ASLValue(
      makeNode(
        'capture',
        { input: toNode(input) },
        { id: opts.id ?? 'capture', windowSize: Math.max(1, Math.floor(opts.windowSize ?? DEFAULT_CAPTURE_WINDOW)) },
      ),
    );
  },
};

/** Peak and RMS over the interval since the previous drain. */
export interface MeterReading {
  /** Largest absolute sample seen. */
  peak: number;
  /** Root mean square over the interval. 0 when no samples were rendered. */
  rms: number;
}

/**
 * One drain of a voice's taps. `captures` are oldest-sample-first copies, so
 * a reader can hand one straight to `fftMagnitude` or `yinPitch`.
 */
export interface AnalysisFrame {
  meters: Record<string, MeterReading>;
  captures: Record<string, Float32Array>;
}

/** Live accumulator behind a `meter` tap. Reset on every drain. */
export interface MeterAccumulator {
  peak: number;
  sumSq: number;
  count: number;
}

/** Live ring buffer behind a `capture` tap. */
export interface CaptureBuffer {
  samples: Float32Array;
  write: number;
  filled: boolean;
}
