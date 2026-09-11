import { decodePresetBlob, decodeAddressedParams, asPresetFilename, type AudioMaterial, type AUv3PluginDescriptor } from './crate';
import { grainParams } from './grainMaterial';

/** AudioComponentDescription subtype for homecrate grain (`grn `). */
export const HOMECRATE_GRAIN_SUBTYPE = 0x67726e20;
/** AudioComponentDescription manufacturer for homecrate grain (`NAMp`). */
export const HOMECRATE_GRAIN_MANUFACTURER = 0x4e414d70;

export interface DecodedGrainPreset {
  params: Record<string, number>;
  grainLoopFilename?: string;
  grainLoopId?: string;
  grainLoopIsUser?: boolean;
  raw: Record<string, unknown>;
}

export function isHomecrateGrain(plugin: AUv3PluginDescriptor | null | undefined): boolean {
  if (!plugin) return false;
  return plugin.componentSubType === HOMECRATE_GRAIN_SUBTYPE;
}

export function decodeGrainPreset(savedPresetData: string): DecodedGrainPreset {
  const raw = decodePresetBlob(savedPresetData);
  const userFlag = raw.grainLoopIsUser;
  return {
    params: decodeAddressedParams(raw, grainParams),
    grainLoopFilename: asPresetFilename(raw.grainLoopFilename),
    grainLoopId: asPresetFilename(raw.grainLoopId),
    grainLoopIsUser: userFlag === true || userFlag === 1 || userFlag === '1',
    raw,
  };
}

export function applyGrainPreset(material: AudioMaterial, decoded: DecodedGrainPreset): void {
  for (const [name, value] of Object.entries(decoded.params)) {
    material.setParam(name, value);
  }
}

export function resolveGrainLoopPath(filename: string): string {
  const safe = filename.replace(/^.*[/\\]/, '');
  return `assets/GrainLoops/${safe}`;
}
