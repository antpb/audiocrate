import { describe, expect, it } from 'vitest';
import { momentaryLufs } from '../../src/dsp/lufs';

describe('momentaryLufs', () => {
  it('silence is the floor', () => {
    expect(momentaryLufs(new Float32Array(4800), 48000)).toBe(-70);
  });

  it('a full-scale sine is louder than a quiet one', () => {
    const sr = 48000;
    const loud = new Float32Array(sr);
    const quiet = new Float32Array(sr);
    for (let i = 0; i < sr; i++) {
      loud[i] = Math.sin((2 * Math.PI * 1000 * i) / sr);
      quiet[i] = loud[i]! * 0.1;
    }
    expect(momentaryLufs(loud, sr)).toBeGreaterThan(momentaryLufs(quiet, sr) + 10);
  });
});
