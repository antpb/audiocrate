import type { AudioMaterialRegistry } from '../registry/AudioMaterialRegistry';
import { audioMaterialRegistry } from '../registry/AudioMaterialRegistry';
import { irPlugin } from './irPlugin';

/**
 * Core Materials that need a `AudioMaterialPlugin` (assets, latency, kernels).
 * Pure ASL Materials (gain, filters, delay, ...) do not register: adding
 * them to a track is enough.
 */
export const corePlugins = [irPlugin] as const;

export function registerCoreMaterials(registry: AudioMaterialRegistry = audioMaterialRegistry): AudioMaterialRegistry {
  registry.registerAll(corePlugins);
  return registry;
}
