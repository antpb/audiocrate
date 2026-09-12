import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FACTORY_KIT_FILES,
  FACTORY_PAD_LABELS,
  FACTORY_PAD_SAMPLES,
  applyFactoryKitParams,
  factoryKitParams,
} from './drumKit';
import { createDrumMaterial } from './drumMaterial';
import { NUM_PADS, drumParams } from './drumParams';

describe('the factory kit', () => {
  it('names a sample and a label for every pad', () => {
    expect(FACTORY_PAD_SAMPLES).toHaveLength(NUM_PADS);
    expect(FACTORY_PAD_LABELS).toHaveLength(NUM_PADS);
    expect(FACTORY_PAD_LABELS[0]).toBe('KICK');
    // Eleven pads, five files: the toms share recordings and are retuned.
    expect(FACTORY_KIT_FILES.length).toBeLessThan(NUM_PADS);
  });

  it('ships every file it asks for', () => {
    // A kit that names a file the build does not carry is a silent pad and
    // no error, which is the failure this package exists to have already had.
    const present = new Set(
      readdirSync(fileURLToPath(new URL('../assets', import.meta.url))).filter((file) =>
        file.endsWith('.wav'),
      ),
    );
    for (const filename of FACTORY_KIT_FILES) {
      expect(present.has(filename), `assets/${filename} is missing`).toBe(true);
    }
  });

  it('sets only parameters the material declares, in range', () => {
    for (const [name, value] of Object.entries(factoryKitParams())) {
      const descriptor = drumParams[name];
      expect(descriptor, `unknown param ${name}`).toBeDefined();
      expect(value, `${name} below min`).toBeGreaterThanOrEqual(descriptor!.min);
      expect(value, `${name} above max`).toBeLessThanOrEqual(descriptor!.max);
    }
  });

  it('applies onto a material', () => {
    const material = createDrumMaterial();
    applyFactoryKitParams(material);
    expect(material.getParam('pad0Bits')).toBe(12);
    expect(material.getParam('pad12Vol')).toBe(1);
    // The kit is voiced through the character filter rather than around it.
    expect(material.getParam('masterIRMix')).toBe(1);
  });

  it('leaves a pad audible: nothing is muted that has no reason to be', () => {
    const params = factoryKitParams();
    const silent = Array.from({ length: NUM_PADS }, (_, pad) => pad).filter(
      (pad) => params[`pad${pad}Vol`] === 0,
    );
    // Pad 14 is at zero in the shipping kit, and that is the kit's business.
    expect(silent).toEqual([14]);
  });
});
