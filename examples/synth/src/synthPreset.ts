import { decodePresetBlob, decodeAddressedParams, asPresetFilename, type AudioMaterial, type AUv3PluginDescriptor } from './crate';
import { synthParams } from './synthMaterial';

/** AudioComponentDescription subtype for homecrate synth (`synt`). */
export const HOMECRATE_SYNTH_SUBTYPE = 0x73796e74;
/** AudioComponentDescription manufacturer for homecrate synth (`HmCr`). */
export const HOMECRATE_SYNTH_MANUFACTURER = 0x486d4372;
export interface DecodedSynthPreset {
  params: Record<string, number>;
  irSlotFilenames: Array<string | undefined>;
  raw: Record<string, unknown>;
}

export function isHomecrateSynth(plugin: AUv3PluginDescriptor | null | undefined): boolean {
  if (!plugin) return false;
  return plugin.componentSubType === HOMECRATE_SYNTH_SUBTYPE;
}

export function decodeSynthPreset(savedPresetData: string): DecodedSynthPreset {
  const raw = decodePresetBlob(savedPresetData);
  const irSlotFilenames = [0, 1, 2, 3, 4, 5].map((i) => asPresetFilename(raw[`irSlot${i}Filename`]));
  return { params: decodeAddressedParams(raw, synthParams), irSlotFilenames, raw };
}

export function applySynthPreset(material: AudioMaterial, decoded: DecodedSynthPreset): void {
  for (const [name, value] of Object.entries(decoded.params)) {
    material.setParam(name, value);
  }
}
