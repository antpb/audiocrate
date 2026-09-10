import { describe, expect, it } from 'vitest';
import { yinPitch } from '../../src/dsp/yin';

function sine(hz: number, sr: number, length: number, amplitude = 1): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) samples[i] = Math.sin((2 * Math.PI * hz * i) / sr) * amplitude;
  return samples;
}

function cents(got: number, expected: number): number {
  return 1200 * Math.log2(got / expected);
}

describe('yinPitch', () => {
  it('finds 440 Hz in a sine', () => {
    const sr = 48000;
    expect(yinPitch(sine(440, sr, 4096), sr)).toBeCloseTo(440, 0);
  });

  /**
   * The tolerance here is the point of the test. A period that is a whole
   * number of samples lands exactly with or without interpolation; one that
   * is not only lands if the interpolation is right, and getting its sign
   * backwards reads as a consistent few cents sharp everywhere.
   */
  it('lands within a couple of cents at pitches whose period is not a whole number of samples', () => {
    const sr = 44100;
    for (const hz of [220, 435, 440, 523.25, 880]) {
      const got = yinPitch(sine(hz, sr, 2048), sr);
      expect(Math.abs(cents(got, hz))).toBeLessThan(2);
    }
  });

  it('is not biased in one direction across a sweep', () => {
    const sr = 44100;
    let sum = 0;
    let count = 0;
    for (let hz = 100; hz <= 800; hz += 37) {
      const got = yinPitch(sine(hz, sr, 2048), sr);
      if (got <= 0) continue;
      sum += cents(got, hz);
      count += 1;
    }
    expect(count).toBeGreaterThan(10);
    expect(Math.abs(sum / count)).toBeLessThan(0.5);
  });

  it('returns -1 for silence', () => {
    expect(yinPitch(new Float32Array(2048), 48000)).toBe(-1);
  });

  it('returns -1 for a window too short to hold a period', () => {
    expect(yinPitch(new Float32Array(8), 48000)).toBe(-1);
  });

  it('respects the search range', () => {
    const sr = 44100;
    // A 100 Hz tone with the search floor above it has nothing to find.
    expect(yinPitch(sine(100, sr, 4096), sr, { minHz: 300 })).toBe(-1);
  });
});
