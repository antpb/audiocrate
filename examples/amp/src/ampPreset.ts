import { decodePresetBlob, decodeAddressedParams, asPresetFilename, type AudioMaterial, type AUv3PluginDescriptor } from './crate';
import { ampParams } from './ampMaterial';

/** AudioComponentDescription subtype for homecrate amp (`namg`). */
export const HOMECRATE_AMP_SUBTYPE = 0x6e616d67;
/** AudioComponentDescription manufacturer for homecrate amp (`NAMp`). */
export const HOMECRATE_AMP_MANUFACTURER = 0x4e414d70;
export interface DecodedAmpPreset {
  params: Record<string, number>;
  namFilename?: string;
  namFilenameR?: string;
  irFilename?: string;
  irFilenameR?: string;
  raw: Record<string, unknown>;
}

export function isHomecrateAmp(plugin: AUv3PluginDescriptor | null | undefined): boolean {
  if (!plugin) return false;
  return plugin.componentSubType === HOMECRATE_AMP_SUBTYPE;
}

export function decodeAmpPreset(savedPresetData: string): DecodedAmpPreset {
  const raw = decodePresetBlob(savedPresetData);
  return {
    params: decodeAddressedParams(raw, ampParams),
    namFilename: asPresetFilename(raw.namFilename),
    namFilenameR: asPresetFilename(raw.namFilenameR),
    irFilename: asPresetFilename(raw.irFilename),
    irFilenameR: asPresetFilename(raw.irFilenameR),
    raw,
  };
}

export function applyAmpPreset(material: AudioMaterial, decoded: DecodedAmpPreset): void {
  for (const [name, value] of Object.entries(decoded.params)) {
    material.setParam(name, value);
  }
}
