import { describe, expect, it } from 'vitest';
import { clipRateScale } from '../src/resampleAudio';

describe('clipRateScale', () => {
  it('slows 44.1k frames on a 48k device so wall time matches the file', () => {
    expect(clipRateScale(44100, 48000)).toBeCloseTo(44100 / 48000, 8);
  });

  it('speeds 48k frames on a 44.1k device', () => {
    expect(clipRateScale(48000, 44100)).toBeCloseTo(48000 / 44100, 8);
  });

  it('is unity when the rates already match', () => {
    expect(clipRateScale(44100, 44100)).toBe(1);
  });
});
