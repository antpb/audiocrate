/**
 * Registers amp, grain, synth, and space-reverb.
 *
 * Two halves that have to agree:
 *
 *  1. This file (main thread): slot mapping, assets, latency, live bind, bake.
 *  2. `worklet/homecrate-voice-processor.ts`: the kernels compiled into the
 *     audio-thread bundle. An AudioWorklet cannot import code at runtime.
 *
 * Register without the matching worklet and `loadKernel` rejects with
 * "no kernel registered for slot ...".
 */
import { audioMaterialRegistry, registerCoreMaterials, type AudioMaterialRegistry } from '../../../src/index';
import { ampPlugin } from '../../amp/src/index';
import { grainPlugin } from '../../grain/src/index';
import { synthPlugin } from '../../synth/src/index';
import { spaceReverbPlugin } from '../../space-reverb/src/index';

export { ampPlugin, grainPlugin, synthPlugin, spaceReverbPlugin };
export { AMP_KERNEL_SLOT } from '../../amp/src/kernelSlot';
export { GRAIN_KERNEL_SLOT } from '../../grain/src/kernelSlot';
export { SYNTH_KERNEL_SLOT } from '../../synth/src/kernelSlot';
export { SPACE_REVERB_KERNEL_SLOT } from '../../space-reverb/src/kernelSlot';

export const homecrateMaterials = [ampPlugin, grainPlugin, synthPlugin, spaceReverbPlugin] as const;

/** Registers the set into a registry (the shared one by default). Idempotent. */
export function registerHomecrateMaterials(registry: AudioMaterialRegistry = audioMaterialRegistry): AudioMaterialRegistry {
  registerCoreMaterials(registry);
  registry.registerAll(homecrateMaterials);
  return registry;
}
