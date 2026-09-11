import type { AudioAssetData, AudioMaterial, TextAssetData } from './crate';

export const AMP_ASSET = {
  nam: 'amp.nam',
  ir: 'amp.ir',
  /**
   * Companion profile: independent right channel when `stereoMode` is on and
   * `channelLink` is off, or morph target B. Mutually exclusive with
   * `stereoMode`.
   */
  namR: 'amp.namR',
  irR: 'amp.irR',
  /**
   * IR filename recorded before bytes are read. Latency has to be known
   * when the impulse itself is not loaded.
   */
  irRef: 'amp.ir.ref',
} as const;

export interface NamAssetData {
  filename: string;
  json: string;
}

function toNam(asset: TextAssetData | NamAssetData | undefined): NamAssetData | undefined {
  if (!asset) return undefined;
  if ('json' in asset) return asset;
  return { filename: asset.filename, json: asset.text };
}

export function ampNamAsset(material: AudioMaterial): NamAssetData | undefined {
  return toNam(material.getAsset<TextAssetData | NamAssetData>(AMP_ASSET.nam));
}

export function ampNamAssetR(material: AudioMaterial): NamAssetData | undefined {
  return toNam(material.getAsset<TextAssetData | NamAssetData>(AMP_ASSET.namR));
}

export function ampIrAsset(material: AudioMaterial): AudioAssetData | undefined {
  return material.getAsset<AudioAssetData>(AMP_ASSET.ir);
}

export function ampIrAssetR(material: AudioMaterial): AudioAssetData | undefined {
  return material.getAsset<AudioAssetData>(AMP_ASSET.irR);
}

export function setAmpNamAsset(material: AudioMaterial, asset: NamAssetData): void {
  material.setAsset(AMP_ASSET.nam, asset);
}

export function setAmpNamAssetR(material: AudioMaterial, asset: NamAssetData): void {
  material.setAsset(AMP_ASSET.namR, asset);
}

export function setAmpIrAsset(material: AudioMaterial, asset: AudioAssetData): void {
  material.setAsset(AMP_ASSET.ir, asset);
  material.setAsset(AMP_ASSET.irRef, asset.filename);
}

export function setAmpIrAssetR(material: AudioMaterial, asset: AudioAssetData): void {
  material.setAsset(AMP_ASSET.irR, asset);
}
