import type { AudioMaterialRegistry } from '../registry/AudioMaterialRegistry';
import { audioMaterialRegistry } from '../registry/AudioMaterialRegistry';
import { irPlugin } from './irPlugin';
import { nativeCrateEffectPlugin, nativeCrateInstrumentPlugin } from '../patcher/nativeCrate';

/**
 * Core Materials that need a `AudioMaterialPlugin` (assets, latency, kernels).
 * Pure ASL Materials (gain, filters, delay, ...) do not register: adding
 * them to a track is enough.
 *
 * The crate AU is here, not with homecrate's kernel plugins, because what it
 * hosts is a crate patch: pure ASL, read with nothing but core.
 */
export const corePlugins = [irPlugin, nativeCrateInstrumentPlugin, nativeCrateEffectPlugin] as const;

export function registerCoreMaterials(registry: AudioMaterialRegistry = audioMaterialRegistry): AudioMaterialRegistry {
  registry.registerAll(corePlugins);
  return registry;
}
