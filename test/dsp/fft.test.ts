import { describe, expect, it } from 'vitest';
import { fftMagnitude, fftRadix2 } from '../../src/dsp/fft';

describe('fftRadix2', () => {
  it('round-trips a real impulse', () => {
    const re = new Float64Array(8);
    const im = new Float64Array(8);
    re[0] = 1;
    fftRadix2(re, im, false);
    fftRadix2(re, im, true);
    expect(re[0]).toBeCloseTo(1, 10);
    for (let i = 1; i < 8; i++) {
      expect(re[i]).toBeCloseTo(0, 10);
      expect(im[i]).toBeCloseTo(0, 10);
    }
  });

  it('round-trips a sine', () => {
    const n = 32;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 3 * i) / n);
    const original = Float64Array.from(re);
    fftRadix2(re, im, false);
    fftRadix2(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(original[i]!, 10);
      expect(im[i]).toBeCloseTo(0, 10);
    }
  });
});

describe('fftMagnitude', () => {
  it('peaks at the sine bin', () => {
    const n = 64;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 4 * i) / n);
    const mag = fftMagnitude(samples);
    let peak = 0;
    let bin = 0;
    for (let i = 0; i < mag.length; i++) {
      if (mag[i]! > peak) {
        peak = mag[i]!;
        bin = i;
      }
    }
    expect(bin).toBe(4);
  });
});
