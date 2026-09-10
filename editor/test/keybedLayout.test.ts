import { describe, expect, it } from 'vitest';
import { displayedOctaves, whiteKeys } from '../src/keybedLayout';

describe('keybedLayout', () => {
  it('shows one octave on a phone and two on a desk', () => {
    expect(displayedOctaves(390)).toBe(1);
    expect(displayedOctaves(800)).toBe(1);
    expect(displayedOctaves(801)).toBe(2);
  });

  it('spans C to the next C', () => {
    expect(whiteKeys(60, 1)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(whiteKeys(60, 2)).toHaveLength(15);
  });
});
