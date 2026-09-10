import { describe, expect, it } from 'vitest';
import { param } from '../../src/graph/param';
import { mapModulatorToParam, modulatorUnit } from '../src/cvMap';

describe('cvMap', () => {
  it('treats a closed unipolar envelope as 0, not the bipolar midpoint', () => {
    expect(modulatorUnit(0, 'unipolar')).toBe(0);
    expect(modulatorUnit(1, 'unipolar')).toBe(1);
    expect(modulatorUnit(0, 'bipolar')).toBe(0.5);
    expect(modulatorUnit(-1, 'bipolar')).toBe(0);
    expect(modulatorUnit(1, 'bipolar')).toBe(1);
  });

  it('opens a log cutoff from min when the ADSR is at rest', () => {
    const cutoff = param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' });
    expect(mapModulatorToParam(cutoff, 0, 'unipolar')).toBeCloseTo(20, 5);
    expect(mapModulatorToParam(cutoff, 1, 'unipolar')).toBeCloseTo(20000, 5);
    expect(mapModulatorToParam(cutoff, 0, 'bipolar')).toBeCloseTo(632.4555, 0);
  });
});
