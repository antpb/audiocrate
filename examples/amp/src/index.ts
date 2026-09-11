/**
 * Amp AudioMaterial plugin. Core crate does not import this.
 *
 * ```ts
 * import { registerAudioMaterial } from 'audiocrate';
 * import { ampPlugin } from './index';
 *
 * registerAudioMaterial(ampPlugin);
 * ```
 *
 * Live playback also needs the kernel in the worklet bundle
 * (`examples/homecrate/worklet/homecrate-voice-processor.ts`).
 */
export { ampPlugin, AMP_IR_LATENCY_SAMPLES } from './plugin';
export { AMP_KERNEL_SLOT } from './kernelSlot';
export {
  ampMaterial,
  ampParams,
  AMP_EQ_FREQS,
  createAmpMaterial,
  toneStack,
  buildAmpNamGraph,
  buildAmpEqOnlyGraph,
} from './ampMaterial';
export {
  decodeAmpPreset,
  applyAmpPreset,
  isHomecrateAmp,
  HOMECRATE_AMP_SUBTYPE,
  HOMECRATE_AMP_MANUFACTURER,
  type DecodedAmpPreset,
} from './ampPreset';
export {
  AMP_ASSET,
  ampNamAsset,
  ampNamAssetR,
  ampIrAsset,
  ampIrAssetR,
  setAmpNamAsset,
  setAmpNamAssetR,
  setAmpIrAsset,
  setAmpIrAssetR,
  type NamAssetData,
} from './assets';
export { processAmpMaterial, type BakeAmpOptions } from './bakeAmp';
export {
  ampKernelFactory,
  setNamMaxFrames,
  getNamMaxFrames,
  type AmpKernelPayload,
  type AmpKernelMessage,
} from './kernel';
export { createNamModel, initNamModule, NamModel, type NamEngineOptions } from './nam/NamEngine';
export type { NamProcessor } from './nam/NamProcessor';
export { createAmpFx, initAmpFxModule, AmpFxModel, type AmpFxEngineOptions } from './fx/AmpFxEngine';
export type { AmpFxProcessor } from './fx/AmpFxProcessor';
