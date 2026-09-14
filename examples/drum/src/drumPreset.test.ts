import { describe, expect, it } from 'vitest';
import { createDrumMaterial } from './drumMaterial';
import { INERT_PARAMS } from './drumParams';
import { applyDrumPreset, decodeDrumPreset, isHomecrateDrum, HOMECRATE_DRUM_SUBTYPE } from './drumPreset';
import { drumPlugin } from './plugin';
import { resolveProjectAssetPath } from './crate';

/**
 * A saved kit, base64 JSON, the way a preset blob arrives.
 *
 * Two flavours because there are two writers: the AU's own `fullState` uses
 * identifiers, and homecrate's host writes `param_<address>`.
 */
function jsonBlob(entries: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(entries), 'utf8').toString('base64');
}

describe('drum preset', () => {
  it('recognises the AU by its component subtype', () => {
    expect(isHomecrateDrum({ componentSubType: HOMECRATE_DRUM_SUBTYPE } as never)).toBe(true);
    expect(isHomecrateDrum({ componentSubType: 0x73796e74 } as never)).toBe(false);
    expect(isHomecrateDrum(null)).toBe(false);
  });

  it('reads pad params and pad sample names out of a kit the AU saved', () => {
    const decoded = decodeDrumPreset(
      jsonBlob({ pad0Bits: 8, pad3Cut: 2200, masterIRMix: 0.4, pad0Sample: 'kick.wav' }),
    );
    expect(decoded.params.pad0Bits).toBe(8);
    expect(decoded.params.pad3Cut).toBe(2200);
    expect(decoded.params.masterIRMix).toBeCloseTo(0.4, 6);
    expect(decoded.padFilenames[0]).toBe('kick.wav');
    expect(decoded.padFilenames[1]).toBeUndefined();
  });

  it('reads the same values written by address, the way the host writes them', () => {
    // `pad0Bits` is address 48 and `masterVol` is 100.
    const decoded = decodeDrumPreset(jsonBlob({ param_48: 6, param_100: 0.5 }));
    expect(decoded.params.pad0Bits).toBe(6);
    expect(decoded.params.masterVol).toBeCloseTo(0.5, 6);
  });

  it('carries a user master IR name without pretending it can run it', () => {
    const decoded = decodeDrumPreset(jsonBlob({ masterIRFile: 'spring.wav' }));
    expect(decoded.masterIrFilename).toBe('spring.wav');
  });

  it('asks for pad files in assets/samples, then assets/Samples', () => {
    const requests = drumPlugin.assetRequests!(
      decodeDrumPreset(jsonBlob({ pad0Sample: 'homecrate_kick2.wav' })),
    );
    expect(requests[0]?.library).toBe('samples');
    expect(requests[0]?.fallbackLibraries).toEqual(['Samples']);
    expect(resolveProjectAssetPath(requests[0]!.library, requests[0]!.filename)).toBe(
      'assets/samples/homecrate_kick2.wav',
    );
  });

  it('applies onto a material', () => {
    const material = createDrumMaterial();
    applyDrumPreset(material, decodeDrumPreset(jsonBlob({ pad2Res: 0.5, masterVol: 0.25 })));
    expect(material.getParam('pad2Res')).toBeCloseTo(0.5, 6);
    expect(material.getParam('masterVol')).toBeCloseTo(0.25, 6);
  });

  it('carries the parameters the graph does not read, so a kit round-trips', () => {
    // Stretch, Character, Humanize and the fade points live in the AU's
    // Swift voice rather than in `dsp/`, so this material stores them and
    // does nothing with them. Losing them on load would quietly rewrite
    // somebody's kit.
    const material = createDrumMaterial();
    expect(INERT_PARAMS).toContain('pad0StretchAmt');
    expect(INERT_PARAMS).toContain('masterHumanize');
    for (const name of INERT_PARAMS) {
      expect(material.params[name], `${name} should still be declared`).toBeDefined();
    }
    applyDrumPreset(material, decodeDrumPreset(jsonBlob({ pad0StretchAmt: 1.5 })));
    expect(material.getParam('pad0StretchAmt')).toBeCloseTo(1.5, 6);
  });
});
