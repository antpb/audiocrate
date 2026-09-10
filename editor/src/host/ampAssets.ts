import type { Material } from '../../../src/index';

export const AMP_ASSET = {
  nam: 'amp.nam',
  ir: 'amp.ir',
  namR: 'amp.namR',
  irR: 'amp.irR',
  irRef: 'amp.ir.ref',
} as const;

export interface NamAssetData {
  filename: string;
  json: string;
}

function toNam(asset: NamAssetData | { filename: string; text: string } | undefined): NamAssetData | undefined {
  if (!asset) return undefined;
  if ('json' in asset) return asset;
  return { filename: asset.filename, json: asset.text };
}

export function ampNamAsset(material: Material): NamAssetData | undefined {
  return toNam(material.getAsset<NamAssetData | { filename: string; text: string }>(AMP_ASSET.nam));
}

export function ampNamAssetR(material: Material): NamAssetData | undefined {
  return toNam(material.getAsset<NamAssetData | { filename: string; text: string }>(AMP_ASSET.namR));
}

export function setAmpNamAsset(material: Material, asset: NamAssetData): void {
  material.setAsset(AMP_ASSET.nam, asset);
}

export function setAmpNamAssetR(material: Material, asset: NamAssetData): void {
  material.setAsset(AMP_ASSET.namR, asset);
}
