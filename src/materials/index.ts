export { synthVoiceMaterial } from './synthVoice';
export { parametricEqMaterial, EQ_BAND_TYPES } from './parametricEq';
export { gainMaterial } from './gain';
export {
  spatialSourceMaterial,
  spatialMasterMaterial,
  SPATIAL_SOURCE_KIND,
  SPATIAL_MASTER_KIND,
  SPATIAL_DECODE_MODES,
} from './spatial';
export { invertMaterial } from './invert';
export {
  lowpassMaterial,
  highpassMaterial,
  bandpassMaterial,
  notchMaterial,
  lowShelfMaterial,
  highShelfMaterial,
  allpassMaterial,
  onePoleLowpassMaterial,
  onePoleHighpassMaterial,
  svfLowpassMaterial,
  svfHighpassMaterial,
  svfBandpassMaterial,
  ladderMaterial,
  combMaterial,
  slopeLowpass12Material,
  slopeLowpass24Material,
  slopeHighpass12Material,
} from './filters';
export {
  oscillatorMaterial,
  OSC_WAVE_NAMES,
  NOISE_COLOR_NAMES,
  toneMaterial,
  noiseMaterial,
  impulseMaterial,
  wavetableMaterial,
  createWavetableMaterial,
  setWavetable,
  setWavetableAsset,
  clearWavetableAsset,
  wavetableAsset,
  WAVETABLE_ASSET,
  wavetableBank,
  WAVETABLE_FRAME_SIZE,
  samplePlayerMaterial,
  createSamplePlayerMaterial,
  setSampleAsset,
  clearSampleAsset,
  sampleAsset,
  SAMPLE_ASSET,
  sineTable,
} from './sources';
export { softClipMaterial, hardClipMaterial } from './clip';
export {
  bitcrushMaterial,
  downsampleMaterial,
  fullRectifyMaterial,
  halfRectifyMaterial,
  waveshapeMaterial,
  WAVESHAPE_CURVES,
} from './nonlinear';
export {
  slewMaterial,
  sampleHoldMaterial,
  compareGreaterMaterial,
  compareLessMaterial,
  clockMaterial,
  clockDivideMaterial,
  clockMultiplyMaterial,
  logicAndMaterial,
  logicOrMaterial,
  logicXorMaterial,
  logicNotMaterial,
  flipFlopMaterial,
  quantizeMaterial,
  euclideanMaterial,
  randomSteppedMaterial,
  randomSmoothMaterial,
  triggerMaterial,
  pulseMaterial,
  sequencerMaterial,
  adsrMaterial,
  lfoMaterial,
  dahdsrMaterial,
  offsetMaterial,
  controlMaterial,
  breakpointEnvelopeMaterial,
} from './control';
export { compressorMaterial, limiterMaterial, gateMaterial, expanderMaterial, transientMaterial } from './dynamics';
export { selectMaterial, panLeftMaterial, panRightMaterial, mixMaterial } from './routing';
export {
  reverseMaterial,
  looperMaterial,
  LOOPER_QUANTIZE_NAMES,
  LOOPER_LENGTH_PRESETS,
  LOOPER_OUTPUTS,
  LOOPER_START_TAP,
  LOOPER_END_TAP,
  isLooperKind,
  isLooperPulseOutput,
  pitchShiftMaterial,
  grainMaterial,
  createGrainMaterial,
  setGrainAsset,
} from './time';
export { rmsMaterial, peakMaterial, onsetMaterial } from './analysis';
export { bypassMaterial } from './bypass';
export { dcBlockerMaterial } from './dcBlocker';
export { delayMaterial } from './delay';
export { reverbMaterial } from './reverb';
export { envelopeFollowerMaterial } from './envelopeFollower';
export { ringModMaterial } from './ringMod';
export {
  irMaterial,
  createIrMaterial,
  setIrAsset,
  irAsset,
  irLatencySamples,
  IR_ASSET,
  IR_ASSET_REF,
} from './ir';
export { irPlugin, setLiveIrPartitionSize } from './irPlugin';
export {
  monoSumMaterial,
  monoLeftMaterial,
  monoRightMaterial,
  channelSwapMaterial,
  stereoWidthMaterial,
  midSideEncodeMaterial,
  midSideDecodeMaterial,
  balanceMaterial,
  stereoPanMaterial,
  autoPanMaterial,
  haasMaterial,
  stereoMergeMaterial,
  createStereoMergeMaterial,
  stereoMaterials,
} from './stereo';
export {
  sidechainCompressorMaterial,
  duckerMaterial,
  sidechainGateMaterial,
  audioMultiplyMaterial,
  audioMixMaterial,
  crossfadeMaterial,
  inputSelectMaterial,
  sidechainMaterials,
  sidechainMaterialFactories,
  createSidechainCompressorMaterial,
  createDuckerMaterial,
  createSidechainGateMaterial,
  createAudioMultiplyMaterial,
  createAudioMixMaterial,
  createCrossfadeMaterial,
  createInputSelectMaterial,
} from './sidechain';
export {
  meterMaterial,
  scopeMaterial,
  analyzerMaterial,
  tunerMaterial,
  createMeterMaterial,
  createScopeMaterial,
  createAnalyzerMaterial,
  createTunerMaterial,
  METER_TAP,
  SCOPE_TAP,
  METER_OUTPUTS,
  SCOPE_OUTPUTS,
  TUNER_OUTPUTS,
  ANALYZER_OUTPUTS,
  isAnalysisKind,
  analysisOutputs,
  isAnalysisAbsoluteOutput,
} from './meters';
export type { AnalysisKind } from './meters';
export {
  syncedDelayMaterial,
  syncedRampMaterial,
  syncedClockMaterial,
  syncedTremoloMaterial,
  syncedMaterials,
} from './synced';
export {
  transportMaterial,
  TRANSPORT_KIND,
  TRANSPORT_OUTPUTS,
  TRANSPORT_ABSOLUTE_OUTPUTS,
  TIME_SIG_PRESETS,
  isTransportKind,
  isTransportOutput,
  isTransportAbsoluteOutput,
  resolvedTransport,
  transportFromMaterial,
  applyTransportToMaterial,
  type TransportOutput,
  type TransportAbsoluteOutput,
  type MaterialTransport,
} from './transport';
export { registerCoreMaterials, corePlugins } from './core';
