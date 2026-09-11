import type { AudioAssetData, AudioMaterial } from './crate';

export const GRAIN_ASSET = {
  loop: 'grain.loop',
} as const;

export function grainLoopAsset(material: AudioMaterial): AudioAssetData | undefined {
  return material.getAsset<AudioAssetData>(GRAIN_ASSET.loop);
}

export function setGrainLoopAsset(material: AudioMaterial, asset: AudioAssetData): void {
  material.setAsset(GRAIN_ASSET.loop, asset);
}
