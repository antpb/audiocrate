/**
 * Build a crate.plugin from the current graph: flatten, validate, and
 * register so the palette can place it. Crate owns the format; this file
 * maps editor kinds to Materials.
 */
import {
  compileMaterial,
  cratePluginDocument,
  detectPatchRole,
  flattenPatch,
  audioMaterialRegistry,
  pluginFromDocument,
  registerAudioMaterial,
  type CratePluginDocument,
  type AudioMaterial,
} from '../../src/index';
import { addCatalogEntry, catalogEntry } from './catalog';
import type { CratePatch } from './patch';

export function resolveKind(kind: string): AudioMaterial | null {
  const entry = catalogEntry(kind);
  if (entry?.create) return entry.create();
  const plugin = audioMaterialRegistry.get(kind);
  return plugin ? plugin.create() : null;
}

export function suggestedRole(patch: CratePatch): 'insert' | 'instrument' {
  return detectPatchRole(patch);
}

/**
 * Flatten here so a missing Master cable or a kernel node fails at export.
 * The flattened AudioMaterial is stored as `compiled` for hosts that cannot run
 * the patcher (Swift AUv3).
 */
export function buildPluginDocument(
  patch: CratePatch,
  label: string,
  role: 'insert' | 'instrument',
): CratePluginDocument {
  const doc = cratePluginDocument({ label, role, patch });
  const material = flattenPatch(doc.patch, { resolve: resolveKind, role, name: label, kind: doc.id });
  return { ...doc, compiled: compileMaterial(material, role, doc.polyphony) };
}

/** Registers the plugin and puts it in the palette under Plugins. */
export function registerPluginDocument(doc: CratePluginDocument): void {
  registerAudioMaterial(pluginFromDocument(doc, { resolve: resolveKind }));
  addCatalogEntry({
    kind: doc.id,
    label: doc.label,
    category: 'Plugins',
    create: () => {
      const plugin = audioMaterialRegistry.get(doc.id);
      if (!plugin) throw new Error(`No plugin registered for kind "${doc.id}"`);
      return plugin.create();
    },
  });
}
