import { materialRegistry, type MaterialRegistry } from '../registry/MaterialRegistry';
import type { AUv3PluginDescriptor } from './pluginSlots';
import type { Material } from '../graph/Material';
import type { MaterialPlugin } from '../registry/MaterialPlugin';

export type MappedPluginSlot =
  | {
      /**
       * The discriminant. `kind` cannot be one: a bound slot's `kind` is its
       * plugin's, an arbitrary string, and TypeScript therefore cannot rule
       * out its being `'skip'`. Every narrowing on `kind` alone silently did
       * nothing, and every caller reached through to `material` and `plugin`
       * on a type that had neither.
       */
      bound: true;
      kind: string;
      role: 'insert' | 'instrument';
      material: Material;
      /**
       * The plugin's own decoded preset. Typed `unknown` because crate does
       * not know the shape: the plugin that produced it does, and a caller
       * that cares narrows it (the plugin package exports its own type and
       * usually a guard).
       */
      preset: unknown;
      plugin: MaterialPlugin;
    }
  | { bound: false; kind: 'skip'; reason: 'empty' | 'unknown'; subtype?: number };

/**
 * Host policy for a project plugin slot: bind whatever the registry claims,
 * skip everything else. Unknown plugins stay on the project untouched; they
 * just do not enter the graph.
 */
export function mapPluginSlot(
  plugin: AUv3PluginDescriptor | null | undefined,
  savedPresetData?: string | null,
  registry: MaterialRegistry = materialRegistry,
): MappedPluginSlot {
  if (!plugin) return { bound: false, kind: 'skip', reason: 'empty' };

  const entry = registry.matchHost(plugin);
  if (!entry) return { bound: false, kind: 'skip', reason: 'unknown', subtype: plugin.componentSubType };

  const material = entry.create();
  // A slot with no saved state still has a preset, just an empty one. Keeping
  // that distinction out of every caller is why `emptyPreset` exists.
  let preset: unknown = entry.emptyPreset?.();
  if (savedPresetData && entry.decodePreset) {
    try {
      preset = entry.decodePreset(savedPresetData);
      entry.applyPreset?.(material, preset);
    } catch (err) {
      // A corrupt preset must not lose the slot. The Material stays at its
      // defaults and the chain still runs, which for an amp means the analog
      // path rather than silence.
      console.warn(`[crate] "${entry.kind}" preset decode failed; defaults only`, err);
      preset = entry.emptyPreset?.();
    }
  }

  return { bound: true, kind: entry.kind, role: entry.role, material, preset, plugin: entry };
}
