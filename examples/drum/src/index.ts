/** Drum AudioMaterial plugin. Register with `registerAudioMaterial(drumPlugin)`. */
export { drumPlugin } from './plugin';
export { createDrumMaterial, drumPluginMaterial, liveDrumGraph, type DrumMaterialOptions } from './drumMaterial';
export {
  NUM_PADS,
  PAD_BASE_NOTE,
  PAD_ADDRESS_BASE,
  MASTER_ADDRESS,
  INERT_PARAMS,
  drumParams,
  drumAutomatable,
  padParamName,
  type PadBank,
} from './drumParams';
export {
  FACTORY_KIT_FILES,
  FACTORY_PAD_LABELS,
  FACTORY_PAD_SAMPLES,
  factoryKitParams,
  applyFactoryKitParams,
} from './drumKit';
export {
  drumPadKey,
  drumPadAsset,
  drumPadAssets,
  setDrumPadAsset,
  clearDrumPadAsset,
} from './drumPads';
export {
  decodeDrumPreset,
  decodeDrumParams,
  applyDrumPreset,
  isHomecrateDrum,
  HOMECRATE_DRUM_SUBTYPE,
  HOMECRATE_DRUM_MANUFACTURER,
  type DecodedDrumPreset,
} from './drumPreset';
export {
  bitCrusher026S,
  bitTrim,
  cascadeLowpass3,
  bilinearOnePoleLowpass,
  fastTan,
  padLowpass,
  panned,
  pow2,
  reciprocal,
  lookup,
  transferCurve,
} from './drumDsp';
export {
  DEFAULT_IR_CUTOFF,
  DEFAULT_IR_LENGTH,
  DEFAULT_IR_RESONANCE,
  IR_FFT_GAIN,
  IR_PART_SIZE,
} from './drumConstants';
/** The C++ port the parity tests measure against, not something the graph calls. */
export { DrumKernel, defaultMasterIR, srCurve } from './reference/DrumKernel';
