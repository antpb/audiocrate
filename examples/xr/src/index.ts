/**
 * The reusable half of this package: crate as a source for three.js audio.
 *
 * `plugin.ts` is one application of it. This is what another XR Publisher
 * plugin, or any three.js project, would import.
 */
export { CrateAudio, createCrateAudio, rendererFor } from './CrateAudio';
export type {
  CrateAudioOptions,
  ThreeAudioLike,
  ThreeListenerLike,
  ThreeNamespaceLike,
} from './CrateAudio';
export {
  attachNodeToHtmlSink,
  describeHostedAudio,
  getHtmlAudioSink,
  prefersHtmlAudioSink,
  shouldConnectWebAudioDestination,
  unlockHostedAudio,
} from './hostedAudio';
export { resonantStoneMaterial } from './materials/resonantStone';
