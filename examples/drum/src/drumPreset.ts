import {
  asPresetFilename,
  decodePresetBlob,
  type AUv3PluginDescriptor,
  type AudioMaterial,
  type ParamDescriptor,
} from './crate';
import { NUM_PADS, drumParams } from './drumParams';

/** AudioComponentDescription subtype for homecrate drum (`drms`). */
export const HOMECRATE_DRUM_SUBTYPE = 0x64726d73;
/** AudioComponentDescription manufacturer for homecrate drum (`NAMp`). */
export const HOMECRATE_DRUM_MANUFACTURER = 0x4e414d70;

export interface DecodedDrumPreset {
  params: Record<string, number>;
  /** Per-pad sample filenames, sparse: the index is the pad, holes included. */
  padFilenames: Array<string | undefined>;
  /**
   * A user-loaded master IR, if the kit had one.
   *
   * Carried and not used. The default character IR is a filter and the graph
   * runs it as one, but an arbitrary impulse response needs convolution, and
   * that is the one stage of this instrument with no ASL expression. Dropping
   * the name on load would lose it on the next save.
   */
  masterIrFilename?: string;
  raw: Record<string, unknown>;
}

export function isHomecrateDrum(plugin: AUv3PluginDescriptor | null | undefined): boolean {
  if (!plugin) return false;
  return plugin.componentSubType === HOMECRATE_DRUM_SUBTYPE;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function clampTo(descriptor: ParamDescriptor, value: number): number {
  return Math.min(descriptor.max, Math.max(descriptor.min, value));
}

/**
 * Two spellings, because the AU and the host write the same value under
 * different keys.
 *
 * `decodeAddressedParams` reads `param_<address>`, which is what homecrate's
 * host writes into a project's plugin slot. The AU's own `fullState` writes
 * identifiers: `pad0Vol`, `masterCut`. A kit saved from the plugin's own
 * editor carries only the second form, so reading only the first decodes an
 * empty kit and reports no error at all.
 */
export function decodeDrumParams(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, descriptor] of Object.entries(drumParams)) {
    const value =
      (descriptor.address !== undefined ? asNumber(raw[`param_${descriptor.address}`]) : undefined) ??
      asNumber(raw[name]);
    if (value === undefined) continue;
    out[name] = clampTo(descriptor, value);
  }
  return out;
}

/** `fullState` writes `pad3Sample`; older kits used `pad3SampleName`. */
function padFilename(raw: Record<string, unknown>, pad: number): string | undefined {
  return asPresetFilename(raw[`pad${pad}Sample`]) ?? asPresetFilename(raw[`pad${pad}SampleName`]);
}

export function decodeDrumPreset(savedPresetData: string): DecodedDrumPreset {
  const raw = decodePresetBlob(savedPresetData);
  const padFilenames = Array.from({ length: NUM_PADS }, (_, pad) => padFilename(raw, pad));
  const masterIrFilename = asPresetFilename(raw.masterIRFile);
  return {
    params: decodeDrumParams(raw),
    padFilenames,
    ...(masterIrFilename ? { masterIrFilename } : {}),
    raw,
  };
}

export function applyDrumPreset(material: AudioMaterial, decoded: DecodedDrumPreset): void {
  for (const [name, value] of Object.entries(decoded.params)) {
    material.setParam(name, value);
  }
}
