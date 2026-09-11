/**
 * Reading a hosted project's plugin slots, without knowing any plugin.
 *
 * Everything here is about the *container*: what a slot looks like in a
 * project file, how to pull an addressed parameter out of a decoded preset
 * blob, where an exported archive keeps referenced files. None of it names a
 * product. The plugin-specific half (what subtype `namg` is, what
 * `namFilename` means) lives in the plugin package that owns it.
 */
import type { ParamDescriptor } from '../graph/param';

/** `aufx`, a plain effect. */
export const AU_TYPE_EFFECT = 0x61756678;
/** `aumf`, an effect that also takes MIDI. */
export const AU_TYPE_MUSIC_EFFECT = 0x61756d66;
/** `aumu`, an instrument. */
export const AU_TYPE_INSTRUMENT = 0x61756d75;

export interface AUv3PluginDescriptor {
  componentType: number;
  componentSubType: number;
  componentManufacturer: number;
  componentName?: string;
  [key: string]: unknown;
}

export interface PluginSlot {
  plugin: AUv3PluginDescriptor | null;
  savedPresetData: string | null;
  enabled?: boolean;
  [key: string]: unknown;
}

/** A track's (or the master bus's) plugin slots, sparse: a null entry is an empty slot. */
export function listPluginSlots(container: { [key: string]: unknown }): Array<PluginSlot | null> {
  const slots = container.pluginSlots;
  if (!Array.isArray(slots)) return [];
  return slots.map((slot) => {
    if (slot === null) return null;
    if (!slot || typeof slot !== 'object') return null;
    return slot as PluginSlot;
  });
}

export function asPresetNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Pulls a filename out of a decoded preset value, unwrapping the `NS.string`
 * box an NSKeyedArchiver blob puts around one. Without the unwrap an imported
 * project's asset references silently read as `undefined`, and a plugin that
 * needs a file quietly runs without it.
 */
export function asPresetFilename(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec['NS.string'] === 'string') return asPresetFilename(rec['NS.string']);
  }
  return undefined;
}

/**
 * Maps a decoded preset's `param_<address>` entries onto named params, using
 * the addresses an AudioMaterial declared via `param.range(..., { address })`.
 *
 * This is the whole reason `address` is on a param descriptor: an AU or VST
 * saves state by numeric address, and a plugin should not need a second
 * hand-maintained address-to-name table to read its own preset back.
 */
export function decodeAddressedParams(
  raw: Record<string, unknown>,
  params: Record<string, ParamDescriptor>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, descriptor] of Object.entries(params)) {
    if (descriptor.address === undefined) continue;
    const value = asPresetNumber(raw[`param_${descriptor.address}`]);
    if (value === undefined) continue;
    out[name] = Math.min(descriptor.max, Math.max(descriptor.min, value));
  }
  return out;
}

/**
 * Where an exported homecrate archive keeps a referenced plugin file:
 * `assets/<library>/<basename>`. The stored reference is a bare filename by
 * design (a sandboxed absolute path does not survive export), so the
 * basename strip is load-bearing, not defensive.
 */
export function resolveProjectAssetPath(library: string, filename: string): string {
  const safe = filename.replace(/^.*[/\\]/, '');
  return `assets/${library}/${safe}`;
}
