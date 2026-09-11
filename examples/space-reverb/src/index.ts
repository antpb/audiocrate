/**
 * Costello AudioMaterial plugin. Core crate does not import this.
 *
 * ```ts
 * import { registerAudioMaterial } from 'audiocrate';
 * import { spaceReverbPlugin } from './index';
 *
 * registerAudioMaterial(spaceReverbPlugin);
 * ```
 *
 * Live playback also needs the kernel in the worklet bundle
 * (`examples/homecrate/worklet/homecrate-voice-processor.ts`).
 */
export { spaceReverbPlugin } from './plugin';
export { SPACE_REVERB_KERNEL_SLOT } from './kernelSlot';
export {
  spaceReverbMaterial,
  spaceReverbParams,
  createSpaceReverbMaterial,
} from './spaceReverbMaterial';
export { processSpaceReverbMaterial, type BakeSpaceReverbOptions } from './bakeSpaceReverb';
export { spaceReverbKernelFactory, type SpaceReverbKernelPayload } from './kernel';
export {
  createSpaceReverb,
  initSpaceReverbModule,
  SpaceReverbModel,
  type SpaceReverbEngineOptions,
} from './engine/SpaceReverbEngine';
export type { SpaceReverbProcessor } from './engine/SpaceReverbProcessor';
