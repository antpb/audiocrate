export { Vec3 } from './Vec3';
export {
  NAMED_POSITIONS,
  SPATIAL_POSITION_NAMES,
  namedPositionVec,
  isNamedSpatialPosition,
  type NamedSpatialPosition,
  type SpatialPositionName,
} from './positions';
export { sphericalToCartesian, cartesianToSpherical, type SphericalPos } from './spherical';
export {
  FOA_W,
  foaGainsFromPoint,
  foaGainsFromDirection,
  foaGainsFromSpherical,
  stereoPanFromY,
  recoverYFromRMS,
  closestNamedPositionByY,
  namedPositionY,
  type FOAGains,
} from './foa';
export { DISTANCE_MODELS, distanceAttenuation, spatialUpdateHz, type DistanceModel } from './distance';
export {
  SPATIAL_SLOT_INDEX,
  SPATIAL_AZIMUTH_PARAM,
  SPATIAL_ELEVATION_PARAM,
  SPATIAL_DISTANCE_PARAM,
  azDegToValue,
  valueToAzDeg,
  elDegToValue,
  valueToElDeg,
  distToValue,
  valueToDist,
} from './lanes';
export { parseSpatialMeta, buildSpatialMeta, isGlobalMeta, type SpatialMetaEntry } from './meta';
export { SpatialListener } from './SpatialListener';
export { SpatialSource, type SpatialSourceOptions, type SpatialSourceTarget } from './SpatialSource';
export { SceneSpatial } from './SceneSpatial';
export { encodeAmbisonics, type AmbisonicLayer, type AmbisonicEncodeOptions, type AmbisonicEncodeResult } from './encode';
export { SpatialBus, type SpatialDecodeMode, type SpatialBusOptions } from './SpatialBus';
export {
  HeadTracker,
  availableHeadTrackerSources,
  poseFromDeviceOrientation,
  poseFromDrag,
  wrapDegrees,
  type HeadTrackerSource,
  type HeadTrackerOptions,
  type HeadPose,
} from './HeadTracker';
export {
  FOA_VIRTUAL_SPEAKERS,
  foaRotationMatrix,
  rotateFoaGains,
  foaSpeakerWeights,
  decodeFoaToSpeaker,
  decodeFoaToStereo,
  type FoaRotation,
  type Direction,
} from './decode';
export {
  defineCrateFoaEncoder,
  FOA_ENCODER_PROCESSOR,
  FOA_CHANNELS,
} from './worklet/defineFoaEncoder';
