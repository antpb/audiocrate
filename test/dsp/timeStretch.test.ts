import { describe, expect, it } from 'vitest';
import {
  bakeClipStretch,
  MAX_STRETCH_RATIO,
  MIN_STRETCH_RATIO,
  clampStretchRatio,
  stretchedLength,
  timeStretch,
} from '../../src/dsp/timeStretch';

const SR = 44100;

function sine(hz: number, seconds: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/**
 * Fundamental by autocorrelation over the middle of the signal.
 *
 * The middle, not the whole thing, because the first and last frames of an
 * overlap-add are half-windowed and would bias a measurement taken across
 * them. This is the assertion that separates a time stretch from a varispeed:
 * `playbackRate` would move this number by exactly the ratio.
 */
function detectHz(samples: Float32Array, sampleRate = SR): number {
  const from = Math.floor(samples.length * 0.3);
  const to = Math.floor(samples.length * 0.7);
  const slice = samples.subarray(from, to);
  const minLag = Math.floor(sampleRate / 2000);
  const maxLag = Math.floor(sampleRate / 50);
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < slice.length; i++) sum += slice[i]! * slice[i + lag]!;
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return sampleRate / bestLag;
}

describe('time stretch', () => {
  it('changes length by the ratio', () => {
    const input = sine(220, 1);
    for (const ratio of [0.5, 0.75, 1.5, 2, 3]) {
      const [out] = timeStretch([input], ratio);
      expect(out!.length, `ratio ${ratio}`).toBe(stretchedLength(input.length, ratio));
      expect(out!.length / input.length, `ratio ${ratio}`).toBeCloseTo(ratio, 3);
    }
  });

  it('preserves pitch, which is the whole reason it is not playbackRate', () => {
    // A varispeed would put the 220 Hz tone at 110 Hz when stretched to double
    // length and at 440 Hz when halved. Both would pass a length check.
    const input = sine(220, 1);
    for (const ratio of [0.5, 2]) {
      const [out] = timeStretch([input], ratio);
      const hz = detectHz(out!);
      expect(hz, `ratio ${ratio} measured ${hz.toFixed(1)} Hz`).toBeGreaterThan(215);
      expect(hz, `ratio ${ratio} measured ${hz.toFixed(1)} Hz`).toBeLessThan(225);
    }
  });

  it('is what a varispeed is not', () => {
    // The comparison stated directly, so the difference is recorded rather
    // than implied: resampling to double length halves the frequency.
    const input = sine(220, 1);
    const resampled = new Float32Array(input.length * 2);
    for (let i = 0; i < resampled.length; i++) resampled[i] = input[Math.floor(i / 2)]!;
    expect(detectHz(resampled)).toBeLessThan(130);

    const [stretched] = timeStretch([input], 2);
    expect(detectHz(stretched!)).toBeGreaterThan(215);
  });

  it('returns an owned copy at ratio 1, not the input', () => {
    // A caller stores the result; handing back the source would let a later
    // edit of the clip mutate the take.
    const input = sine(440, 0.1);
    const [out] = timeStretch([input], 1);
    expect(out).not.toBe(input);
    expect(Array.from(out!)).toEqual(Array.from(input));
  });

  it('keeps stereo channels locked to one hop schedule', () => {
    // Independently aligned channels drift apart and a stereo take collapses
    // toward mono. Two identical channels must come back identical.
    const input = sine(330, 0.5);
    const [left, right] = timeStretch([input, Float32Array.from(input)], 1.7);
    expect(Array.from(left!)).toEqual(Array.from(right!));
  });

  it('clamps to the range iOS clamps to', () => {
    expect(clampStretchRatio(0.01)).toBe(MIN_STRETCH_RATIO);
    expect(clampStretchRatio(99)).toBe(MAX_STRETCH_RATIO);
    expect(clampStretchRatio(0)).toBe(1);
    expect(clampStretchRatio(-2)).toBe(1);
    expect(clampStretchRatio(Number.NaN)).toBe(1);
    expect(clampStretchRatio(1.5)).toBe(1.5);
  });

  it('survives degenerate input', () => {
    expect(timeStretch([], 2)).toEqual([]);
    expect(timeStretch([new Float32Array(0)], 2)[0]!.length).toBe(0);
  });

  it('does not clip a signal that was already at full scale', () => {
    // A Hann pair at 50% overlap sums to unity, so overlap-add must not add
    // gain. If it did, every stretched clip would come back hotter than the
    // take it came from.
    const input = sine(220, 0.5);
    const [out] = timeStretch([input], 1.5);
    let peak = 0;
    for (const value of out!) peak = Math.max(peak, Math.abs(value));
    expect(peak).toBeLessThanOrEqual(1.05);
    expect(peak).toBeGreaterThan(0.7);
  });

  it('is deterministic, so a bounce twice is the same file', () => {
    const input = sine(220, 0.3);
    const a = timeStretch([input], 1.8)[0]!;
    const b = timeStretch([input], 1.8)[0]!;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('baking a clip into timeline time', () => {
  it('bakes a plain stretch and leaves nothing for a rate to do', () => {
    const input = sine(220, 1);
    const [out] = bakeClipStretch([input], SR, { stretchRatio: 2 });
    expect(out!.length).toBe(stretchedLength(input.length, 2));
    expect(detectHz(out!)).toBeGreaterThan(215);
    expect(detectHz(out!)).toBeLessThan(225);
  });

  it('lays warp segments at their own timeline offsets', () => {
    // Two seconds at rate 1 then two seconds at rate 2: four file seconds
    // become six timeline seconds, and the second half is where the map says.
    const input = sine(220, 4);
    const [out] = bakeClipStretch([input], SR, {
      warpSegments: [
        { fileStartSec: 0, fileEndSec: 2, ratio: 1, localOffsetSec: 0 },
        { fileStartSec: 2, fileEndSec: 4, ratio: 2, localOffsetSec: 2 },
      ],
    });
    expect(out!.length / SR).toBeCloseTo(6, 1);
  });

  it('lets warp segments replace the stretch ratio rather than compound with it', () => {
    // The rule stated everywhere else in crate. A ratio alongside segments
    // must be ignored, not multiplied in.
    const input = sine(220, 4);
    const segments = [
      { fileStartSec: 0, fileEndSec: 2, ratio: 1, localOffsetSec: 0 },
      { fileStartSec: 2, fileEndSec: 4, ratio: 2, localOffsetSec: 2 },
    ];
    const withRatio = bakeClipStretch([input], SR, { stretchRatio: 3, warpSegments: segments })[0]!;
    const without = bakeClipStretch([input], SR, { warpSegments: segments })[0]!;
    expect(withRatio.length).toBe(without.length);
  });

  it('keeps a warped clip in tune too', () => {
    const input = sine(220, 4);
    const [out] = bakeClipStretch([input], SR, {
      warpSegments: [{ fileStartSec: 0, fileEndSec: 4, ratio: 2, localOffsetSec: 0 }],
    });
    expect(detectHz(out!)).toBeGreaterThan(215);
    expect(detectHz(out!)).toBeLessThan(225);
  });

  it('is a no-op at ratio 1 with no segments', () => {
    const input = sine(440, 0.2);
    const [out] = bakeClipStretch([input], SR, { stretchRatio: 1 });
    expect(Array.from(out!)).toEqual(Array.from(input));
  });
});
