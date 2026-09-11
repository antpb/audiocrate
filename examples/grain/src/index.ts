/** Grain AudioMaterial plugin. Register with `registerAudioMaterial(grainPlugin)`. */
export { grainPlugin } from './plugin';
export { GRAIN_KERNEL_SLOT } from './kernelSlot';
export { grainMaterial, grainParams, createGrainMaterial } from './grainMaterial';
export {
  decodeGrainPreset,
  applyGrainPreset,
  isHomecrateGrain,
  resolveGrainLoopPath,
  HOMECRATE_GRAIN_SUBTYPE,
  HOMECRATE_GRAIN_MANUFACTURER,
  type DecodedGrainPreset,
} from './grainPreset';
export { GRAIN_ASSET, grainLoopAsset, setGrainLoopAsset } from './assets';
export { grainKernelFactory, type GrainKernelPayload, type GrainKernelMessage } from './kernel';
export { createGrainFx, initGrainFxModule, GrainFxModel, type GrainEngineOptions } from './engine/GrainEngine';
export type { GrainProcessor } from './engine/GrainProcessor';
