import { AU_TYPE_EFFECT, type AssetRequest, type AudioMaterialPlugin, type AudioMaterial, type VoiceHandle, type KernelBinaryMap } from './crate';
import { createAmpMaterial } from './ampMaterial';
import { AMP_ASSET, ampNamAsset, ampNamAssetR } from './assets';
import { AMP_KERNEL_SLOT } from './kernelSlot';
import { HOMECRATE_AMP_MANUFACTURER, HOMECRATE_AMP_SUBTYPE, applyAmpPreset, decodeAmpPreset, type DecodedAmpPreset } from './ampPreset';
import { processAmpMaterial } from './bakeAmp';
import type { AmpKernelPayload } from './kernel';

/** Legacy Amp cabinet hop. Amp no longer convolves; use the IR AudioMaterial. */
export const AMP_IR_LATENCY_SAMPLES = 512;

export const ampPlugin: AudioMaterialPlugin<DecodedAmpPreset> = {
  kind: 'amp',
  label: 'Amp',
  role: 'insert',

  create: createAmpMaterial,

  host: {
    componentType: AU_TYPE_EFFECT,
    componentSubType: HOMECRATE_AMP_SUBTYPE,
    componentManufacturer: HOMECRATE_AMP_MANUFACTURER,
  },

  decodePreset: decodeAmpPreset,
  emptyPreset: () => ({ params: {}, raw: {} }),

  applyPreset(material, preset) {
    applyAmpPreset(material, preset);
  },

  assetRequests(preset): AssetRequest[] {
    const requests: AssetRequest[] = [];
    const add = (key: string, library: string, filename: string | undefined, decode: 'text' | 'audio') => {
      if (filename) requests.push({ key, library, filename, decode });
    };
    add(AMP_ASSET.nam, 'NAM', preset.namFilename, 'text');
    add(AMP_ASSET.ir, 'IR', preset.irFilename, 'audio');
    add(AMP_ASSET.namR, 'NAM', preset.namFilenameR, 'text');
    add(AMP_ASSET.irR, 'IR', preset.irFilenameR, 'audio');
    return requests;
  },

  latencySamples(_material) {
    return 0;
  },

  async bindLiveVoice(voice: VoiceHandle, material: AudioMaterial, binaries: KernelBinaryMap) {
    const nam = ampNamAsset(material);
    const namR = ampNamAssetR(material);
    const stereo = material.getParam('stereoMode') >= 0.5;
    const payload: AmpKernelPayload = {
      ampFxWasm: binaries[AMP_KERNEL_SLOT] ?? binaries.ampFx,
      namWasm: binaries.nam,
      namJson: nam?.json,
      namJsonR: namR?.json ?? (stereo ? nam?.json : undefined),
    };
    // Load even with no profile: reverb and delay still run. No profile is
    // the analog path. Cabinet convolution is the IR AudioMaterial.
    await voice.loadKernel(AMP_KERNEL_SLOT, payload);
  },

  bakeMode: 'joint',

  async bake(material, channels, sampleRate, binaries) {
    return processAmpMaterial(material, [...channels], sampleRate, {
      namWasmBinary: binaries.nam,
      ampFxWasmBinary: binaries[AMP_KERNEL_SLOT] ?? binaries.ampFx,
    });
  },
};
