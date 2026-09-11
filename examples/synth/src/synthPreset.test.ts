import { describe, expect, it } from 'vitest';
import { createSynthMaterial } from './synthMaterial';
import {
  applySynthPreset,
  decodeSynthPreset,
  isHomecrateSynth,
  HOMECRATE_SYNTH_SUBTYPE,
} from './synthPreset';
import { AU_TYPE_INSTRUMENT } from './crate';

function jsonBlob(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

describe('synthPreset', () => {
  it('identifies the synt subtype', () => {
    expect(
      isHomecrateSynth({
        componentType: AU_TYPE_INSTRUMENT,
        componentSubType: HOMECRATE_SYNTH_SUBTYPE,
        componentManufacturer: 0x486d4372,
      }),
    ).toBe(true);
    expect(
      isHomecrateSynth({
        componentType: 0x61756678,
        componentSubType: 0x6e616d67,
        componentManufacturer: 0x4e414d70,
      }),
    ).toBe(false);
  });

  it('decodes param_N floats and IR slot filenames', () => {
    const decoded = decodeSynthPreset(
      jsonBlob({
        param_9: 0.4,
        param_15: 1200,
        irSlot0Filename: 'room.wav',
        irSlot3Filename: 'plate.wav',
      }),
    );
    expect(decoded.params.oscMasterLevel).toBeCloseTo(0.4);
    expect(decoded.params.filterCutoff).toBeCloseTo(1200);
    expect(decoded.irSlotFilenames[0]).toBe('room.wav');
    expect(decoded.irSlotFilenames[3]).toBe('plate.wav');
    expect(decoded.irSlotFilenames[1]).toBeUndefined();
    const material = createSynthMaterial();
    applySynthPreset(material, decoded);
    expect(material.getParam('oscMasterLevel')).toBeCloseTo(0.4);
  });
});
