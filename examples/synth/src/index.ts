/** Synth AudioMaterial plugin. Register with `registerAudioMaterial(synthPlugin)`. */
export { synthPlugin } from './plugin';
export { SYNTH_KERNEL_SLOT } from './kernelSlot';
export { synthPluginMaterial, synthParams, createSynthMaterial } from './synthMaterial';
export {
  decodeSynthPreset,
  applySynthPreset,
  isHomecrateSynth,
  HOMECRATE_SYNTH_SUBTYPE,
  HOMECRATE_SYNTH_MANUFACTURER,
  type DecodedSynthPreset,
} from './synthPreset';
export {
  SYNTH_IR_SLOT_COUNT,
  synthIrSlotKey,
  synthIrSlotAsset,
  setSynthIrSlotAsset,
  synthIrSlots,
} from './assets';
export { synthKernelFactory, type SynthKernelPayload, type SynthKernelMessage } from './kernel';
export { createSynthFx, initSynthFxModule, SynthFxModel, type SynthEngineOptions } from './engine/SynthEngine';
export type { SynthProcessor } from './engine/SynthProcessor';
