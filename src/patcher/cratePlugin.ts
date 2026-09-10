/**
 * The shareable plugin document: a `crate.plugin` is a patch plus the
 * metadata a host needs to register it (`MaterialPlugin`). The full inner
 * patch rides along so a patcher can reopen and edit what it exported;
 * flattening happens at `create()`, never at save.
 *
 * The synthetic host identity exists so `mapPluginSlot` and a project's
 * saved slots address a user plugin exactly the way they address a native
 * one: a stable subtype hashed from the plugin id, under one shared
 * user-plugin manufacturer code.
 */
import { AU_TYPE_EFFECT, AU_TYPE_INSTRUMENT } from '../host/pluginSlots';
import type { Material } from '../graph/Material';
import type { MaterialPlugin } from '../registry/MaterialPlugin';
import type { CompiledMaterialDocument } from './compiledPlugin';
import {
  flattenPatch,
  type PatchDocument,
  type PatchDocumentConnection,
  type PatchDocumentNode,
  type PatchIoKinds,
} from './flattenPatch';

export const CRATE_PLUGIN_KIND = 'crate.plugin';
export const CRATE_PLUGIN_VERSION = 1;

/** 'CrUs', the manufacturer code every user-authored crate.plugin shares. */
export const USER_PLUGIN_MANUFACTURER = 0x43725573;

export interface CratePluginDocument {
  version: number;
  kind: typeof CRATE_PLUGIN_KIND;
  /** Registry kind, e.g. `user.shimmer-chain`. Also hashes to the AU subtype. */
  id: string;
  label: string;
  role: 'insert' | 'instrument';
  polyphony?: number;
  steal?: 'oldest' | 'quietest';
  /**
   * The full patch document. Typed as the shape flatten reads; a patcher's
   * own superset (positions, its own kind tag) rides through parse intact.
   */
  patch: PatchDocument;
  /**
   * The flattened graph and parameter schema, for hosts that cannot run
   * `flattenPatch` (a Swift AUv3, say). Optional and additive: a document
   * written before this existed still parses, and a host that has a patcher
   * ignores it and flattens `patch` itself.
   *
   * See `patcher/compiledPlugin.ts` for why this is a stored artifact rather
   * than something the other side derives.
   */
  compiled?: CompiledMaterialDocument;
}

export function isCratePluginDocument(value: unknown): value is CratePluginDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as CratePluginDocument;
  return (
    doc.kind === CRATE_PLUGIN_KIND &&
    typeof doc.version === 'number' &&
    typeof doc.id === 'string' &&
    doc.id.length > 0 &&
    typeof doc.label === 'string' &&
    (doc.role === 'insert' || doc.role === 'instrument') &&
    !!doc.patch &&
    typeof doc.patch === 'object' &&
    Array.isArray((doc.patch as PatchDocument).nodes) &&
    Array.isArray((doc.patch as PatchDocument).connections)
  );
}

export function parseCratePlugin(text: string): CratePluginDocument {
  const parsed = JSON.parse(text) as unknown;
  if (!isCratePluginDocument(parsed)) throw new Error('Not a crate.plugin document');
  return parsed;
}

export function stringifyCratePlugin(doc: CratePluginDocument): string {
  return JSON.stringify(doc, null, 2);
}

export interface CratePluginDocumentOptions {
  label: string;
  role: 'insert' | 'instrument';
  patch: PatchDocument;
  /** Defaults to `user.` plus a slug of the label. */
  id?: string;
  polyphony?: number;
  steal?: 'oldest' | 'quietest';
}

export function cratePluginDocument(options: CratePluginDocumentOptions): CratePluginDocument {
  const slug = options.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin';
  const doc: CratePluginDocument = {
    version: CRATE_PLUGIN_VERSION,
    kind: CRATE_PLUGIN_KIND,
    id: options.id ?? `user.${slug}`,
    label: options.label,
    role: options.role,
    patch: {
      ...options.patch,
      nodes: options.patch.nodes.map((node) => ({ ...node })) as PatchDocumentNode[],
      connections: options.patch.connections.map((conn) => ({ ...conn })) as PatchDocumentConnection[],
    },
  };
  if (options.polyphony != null) doc.polyphony = options.polyphony;
  if (options.steal) doc.steal = options.steal;
  return doc;
}

/**
 * FNV-1a of the plugin id, forced positive and nonzero: a stable 32-bit
 * subtype so the same document maps to the same project slot forever.
 */
export function pluginSubtypeFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const positive = hash >>> 1;
  return positive === 0 ? 1 : positive;
}

/** A crate.plugin preset is a plain map of published param values. */
export type CratePluginPreset = Record<string, number>;

export interface PluginFromDocumentOptions {
  resolve: (kind: string) => Material | null | undefined;
  io?: Partial<PatchIoKinds>;
}

export function pluginFromDocument(
  doc: CratePluginDocument,
  options: PluginFromDocumentOptions,
): MaterialPlugin<CratePluginPreset> {
  return {
    kind: doc.id,
    label: doc.label,
    role: doc.role,
    create: () =>
      flattenPatch(doc.patch, {
        resolve: options.resolve,
        io: options.io,
        name: doc.label,
        kind: doc.id,
        role: doc.role,
        polyphony: doc.polyphony,
        voiceStealing: doc.steal,
      }),
    host: {
      componentType: doc.role === 'instrument' ? AU_TYPE_INSTRUMENT : AU_TYPE_EFFECT,
      componentSubType: pluginSubtypeFromId(doc.id),
      componentManufacturer: USER_PLUGIN_MANUFACTURER,
    },
    decodePreset(blob) {
      const raw = JSON.parse(blob) as unknown;
      const preset: CratePluginPreset = {};
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === 'number' && Number.isFinite(value)) preset[key] = value;
        }
      }
      return preset;
    },
    emptyPreset: () => ({}),
    applyPreset(material, preset) {
      for (const [key, value] of Object.entries(preset)) {
        if (!(key in material.params)) continue;
        try {
          material.setParam(key, value);
        } catch {
          /* an out-of-range saved value keeps the default */
        }
      }
    },
  };
}
