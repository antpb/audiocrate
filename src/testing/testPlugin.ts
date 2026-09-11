/**
 * Two AudioMaterial plugins that exist only for crate's own tests.
 *
 * They matter more than the usual fixture. Audiocrate's host paths (project slot
 * mapping, asset hydration, PDC, live binding, baking, export staging) used to
 * be tested against homecrate's real amp, which meant those tests could pass
 * while quietly depending on something only homecrate ships. Testing them
 * against a plugin crate has genuinely never heard of is the only way to know
 * the extension points are real extension points and not a shape the amp
 * happens to fit.
 *
 * "Fuzz" is an insert with a seam kernel, one referenced file, and reported
 * latency. "Tone" is an instrument with a source kernel. Between them they
 * exercise every optional field on `AudioMaterialPlugin`.
 */
import { AudioMaterial } from '../graph/AudioMaterial';
import { param } from '../graph/param';
import { kernel } from '../asl/builders';
import { decodeAddressedParams, asPresetFilename, AU_TYPE_EFFECT, AU_TYPE_INSTRUMENT } from '../host/pluginSlots';
import { decodePresetBlob } from '../loaders/decodeKeyedArchive';
import type { AssetRequest, AudioAssetData } from '../graph/assets';
import type { AudioMaterialPlugin } from '../registry/AudioMaterialPlugin';
import type { RangeParamDescriptor } from '../graph/param';

export const FUZZ_KERNEL_SLOT = 'test.fuzz';
export const TONE_KERNEL_SLOT = 'test.tone';

/** `fuzz` / `TEST` as AudioComponentDescription codes. */
export const FUZZ_SUBTYPE = 0x66757a7a;
export const TONE_SUBTYPE = 0x746f6e65;
export const TEST_MANUFACTURER = 0x54455354;

/** Latency the fuzz plugin claims once its curve file is referenced. */
export const FUZZ_CURVE_LATENCY_SAMPLES = 64;

export const FUZZ_ASSET_KEY = 'fuzz.curve';
const FUZZ_CURVE_REF = 'fuzz.curve.ref';

export const fuzzParams: Record<string, RangeParamDescriptor> = {
  drive: param.range(0, 4, { default: 1, unit: 'lin', address: 0 }),
  tone: param.range(-12, 12, { default: 0, unit: 'dB', address: 1 }),
};

export function createFuzzMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'Fuzz',
    kind: 'test.fuzz',
    params: fuzzParams,
    automatable: Object.keys(fuzzParams),
    graph: ({ input, params }) => kernel.seam(FUZZ_KERNEL_SLOT, input.mul(params.drive)),
  });
}

export interface DecodedFuzzPreset {
  params: Record<string, number>;
  curveFilename?: string;
  raw: Record<string, unknown>;
}

export const fuzzPlugin: AudioMaterialPlugin<DecodedFuzzPreset> = {
  kind: 'test.fuzz',
  label: 'Fuzz',
  role: 'insert',
  create: createFuzzMaterial,
  host: {
    componentType: AU_TYPE_EFFECT,
    componentSubType: FUZZ_SUBTYPE,
    componentManufacturer: TEST_MANUFACTURER,
  },
  decodePreset(blob) {
    const raw = decodePresetBlob(blob);
    return {
      params: decodeAddressedParams(raw, fuzzParams),
      curveFilename: asPresetFilename(raw.curveFilename),
      raw,
    };
  },
  emptyPreset: () => ({ params: {}, raw: {} }),
  applyPreset(material, preset) {
    for (const [name, value] of Object.entries(preset.params)) material.setParam(name, value);
    if (preset.curveFilename) material.setAsset(FUZZ_CURVE_REF, preset.curveFilename);
  },
  assetRequests(preset): AssetRequest[] {
    if (!preset.curveFilename) return [];
    return [{ key: FUZZ_ASSET_KEY, library: 'Curves', filename: preset.curveFilename, decode: 'audio' }];
  },
  latencySamples(material) {
    return material.hasAsset(FUZZ_ASSET_KEY) || material.hasAsset(FUZZ_CURVE_REF)
      ? FUZZ_CURVE_LATENCY_SAMPLES
      : 0;
  },
  async bindLiveVoice(voice, material, binaries) {
    await voice.loadKernel(FUZZ_KERNEL_SLOT, { wasm: binaries[FUZZ_KERNEL_SLOT] });
    const curve = material.getAsset<AudioAssetData>(FUZZ_ASSET_KEY);
    if (curve) voice.sendKernel(FUZZ_KERNEL_SLOT, { type: 'setCurve', samples: curve.samples });
  },
};

export function createToneMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'Tone',
    kind: 'test.tone',
    params: { level: param.range(0, 1, { default: 0.5, address: 0 }) },
    graph: () => kernel.source(TONE_KERNEL_SLOT, undefined, { fallback: 'silence' }),
  });
}

export const tonePlugin: AudioMaterialPlugin<{ params: Record<string, number>; raw: Record<string, unknown> }> = {
  kind: 'test.tone',
  label: 'Tone',
  role: 'instrument',
  create: createToneMaterial,
  host: {
    componentType: AU_TYPE_INSTRUMENT,
    componentSubType: TONE_SUBTYPE,
    componentManufacturer: TEST_MANUFACTURER,
  },
  decodePreset(blob) {
    const raw = decodePresetBlob(blob);
    return { params: decodeAddressedParams(raw, { level: param.range(0, 1, { default: 0.5, address: 0 }) }), raw };
  },
  emptyPreset: () => ({ params: {}, raw: {} }),
  applyPreset(material, preset) {
    for (const [name, value] of Object.entries(preset.params)) material.setParam(name, value);
  },
  async bindLiveVoice(voice) {
    await voice.loadKernel(TONE_KERNEL_SLOT, {});
  },
};

/** Both plugins, for a test that just needs the registry populated. */
export const testPlugins = [fuzzPlugin, tonePlugin] as const;
