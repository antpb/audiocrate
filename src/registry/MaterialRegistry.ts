import type { Material } from '../graph/Material';
import type { HostPluginIdentity, MaterialPlugin } from './MaterialPlugin';

/** Reserved by `mapPluginSlot` to mean "nothing bound here". */
const RESERVED_KINDS = new Set(['skip']);

function hasManufacturer(n: number | undefined): n is number {
  return n !== undefined && n !== 0;
}

/**
 * The set of Material types a given application knows about.
 *
 * Registration is explicit and per-application, not global-by-import-side-
 * effect, so an app that wants an amp says so and an app that does not never
 * pays for one. Crate itself registers nothing here.
 *
 * A registry instance is also a test seam: a test can
 * build its own registry with one fake plugin instead of inheriting whatever
 * the app happened to register.
 */
export class MaterialRegistry {
  private readonly byKind = new Map<string, MaterialPlugin>();

  /**
   * Adds a plugin. Re-registering the same kind replaces it, which is what a
   * dev-server hot reload needs; registering a different plugin under a kind
   * that is already taken is a mistake worth throwing on, since the loser
   * would silently never be used.
   */
  register(plugin: MaterialPlugin): this {
    if (RESERVED_KINDS.has(plugin.kind)) {
      throw new RangeError(`MaterialRegistry: "${plugin.kind}" is a reserved kind`);
    }
    if (!plugin.kind) {
      throw new RangeError('MaterialRegistry: a plugin needs a non-empty kind');
    }
    this.byKind.set(plugin.kind, plugin);
    return this;
  }

  registerAll(plugins: Iterable<MaterialPlugin>): this {
    for (const plugin of plugins) this.register(plugin);
    return this;
  }

  unregister(kind: string): boolean {
    return this.byKind.delete(kind);
  }

  get(kind: string): MaterialPlugin | undefined {
    return this.byKind.get(kind);
  }

  /** The plugin that created this Material, by its `kind`. */
  forMaterial(material: Material): MaterialPlugin | undefined {
    return this.byKind.get(material.kind);
  }

  /**
   * The plugin claiming a native plugin identity. Match is subtype plus
   * manufacturer. Type (`aufx` / `aumf` / `aumu`) is a capability flag, not
   * identity: the same product often registers twice, once as a plain
   * effect and once as a MIDI effect, with the same subtype.
   *
   * An entry with no manufacturer, or a manufacturer of 0, matches on
   * subtype alone. A host may know less about a slot than the plugin
   * declares.
   */
  matchHost(identity: HostPluginIdentity | null | undefined): MaterialPlugin | undefined {
    if (!identity) return undefined;
    for (const plugin of this.byKind.values()) {
      const claim = plugin.host;
      if (!claim) continue;
      if (claim.componentSubType !== identity.componentSubType) continue;
      if (hasManufacturer(claim.componentManufacturer) && hasManufacturer(identity.componentManufacturer)) {
        if (claim.componentManufacturer !== identity.componentManufacturer) continue;
      }
      return plugin;
    }
    return undefined;
  }

  list(): readonly MaterialPlugin[] {
    return [...this.byKind.values()];
  }

  get size(): number {
    return this.byKind.size;
  }

  clear(): void {
    this.byKind.clear();
  }
}

/**
 * The registry crate's own host-facing helpers consult when a caller does not
 * pass one: `mapPluginSlot`, `loadProjectScene`, `prepareLiveVoices`,
 * `bakeTrackInserts`. An application registers into this once at startup.
 *
 * A shared default exists because threading a registry through every call
 * site of a DAW is friction with no payoff for the common case of one app,
 * one plugin set. Every one of those functions still accepts an explicit
 * registry, so the default is a convenience and never a hidden dependency a
 * test cannot escape.
 */
export const materialRegistry = new MaterialRegistry();

/** Shorthand for `materialRegistry.register(plugin)`. */
export function registerMaterial(plugin: MaterialPlugin): void {
  materialRegistry.register(plugin);
}
