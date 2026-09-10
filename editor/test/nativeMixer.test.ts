import { describe, expect, it } from 'vitest';
import { stereoPanGains } from '../src/nativeMixer';

describe('stereoPanGains', () => {
  it('is identity at center', () => {
    const g = stereoPanGains(0);
    expect(g.keep).toBe(1);
    expect(g.fold).toBe(0);
    expect(g.lawL).toBeCloseTo(1, 8);
    expect(g.lawR).toBeCloseTo(1, 8);
  });

  it('folds to mono on the right at hard right', () => {
    const g = stereoPanGains(1);
    expect(g.keep).toBeCloseTo(0.5, 8);
    expect(g.fold).toBeCloseTo(0.5, 8);
    expect(g.lawL).toBeCloseTo(0, 8);
    expect(g.lawR).toBeCloseTo(Math.SQRT2, 8);
  });
});
