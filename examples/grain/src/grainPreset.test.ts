import { describe, expect, it } from 'vitest';
import { createGrainMaterial } from './grainMaterial';
import { applyGrainPreset, decodeGrainPreset, isHomecrateGrain, HOMECRATE_GRAIN_SUBTYPE } from './grainPreset';

function jsonBlob(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

describe('grainPreset', () => {
  it('identifies the grn subtype', () => {
    expect(
      isHomecrateGrain({
        componentType: 0x61756678,
        componentSubType: HOMECRATE_GRAIN_SUBTYPE,
        componentManufacturer: 0x4e414d70,
      }),
    ).toBe(true);
    expect(
      isHomecrateGrain({
        componentType: 0x61756678,
        componentSubType: 0x6e616d67,
        componentManufacturer: 0x4e414d70,
      }),
    ).toBe(false);
  });

  it('decodes param_N floats and the loop filename', () => {
    const decoded = decodeGrainPreset(
      jsonBlob({
        param_0: 1.5,
        param_30: 0.4,
        param_104: 2741,
        grainLoopFilename: 'Summer rain catch.wav',
        grainLoopIsUser: true,
      }),
    );
    expect(decoded.params.inputGain).toBeCloseTo(1.5);
    expect(decoded.params.grainMix).toBeCloseTo(0.4);
    expect(decoded.params.keyMask).toBe(2741);
    expect(decoded.grainLoopFilename).toBe('Summer rain catch.wav');
    expect(decoded.grainLoopIsUser).toBe(true);
    const material = createGrainMaterial();
    applyGrainPreset(material, decoded);
    expect(material.getParam('grainMix')).toBeCloseTo(0.4);
  });
});
