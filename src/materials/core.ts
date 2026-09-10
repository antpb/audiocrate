import type { MaterialRegistry } from '../registry/MaterialRegistry';
import { materialRegistry } from '../registry/MaterialRegistry';
import { irPlugin } from './irPlugin';

/**
 * Core Materials that need a `MaterialPlugin` (assets, latency, kernels).
 * Pure ASL Materials (gain, filters, delay, ...) do not register: adding
 * them to a track is enough.
 */
export const corePlugins = [irPlugin] as const;

export function registerCoreMaterials(registry: MaterialRegistry = materialRegistry): MaterialRegistry {
  registry.registerAll(corePlugins);
  return registry;
}
