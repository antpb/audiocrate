import {
  clearSampleAsset,
  clearWavetableAsset,
  decodeAudioFile,
  irAsset,
  sampleAsset,
  setIrAsset,
  setSampleAsset,
  setWavetableAsset,
  wavetableAsset,
  type AudioAssetData,
  type Material,
} from '../../src/index';
import {
  AMP_ASSET,
  ampNamAsset,
  ampNamAssetR,
  setAmpNamAsset,
  setAmpNamAssetR,
  type NamAssetData,
} from './host/ampAssets';
import { IR_ASSET, IR_ASSET_REF } from '../../src/materials/ir';
import { decodeHostedAudio } from './host/decodeAudio';
import factoryNamUrl from '../../../crate-amp/wasm/fixtures/red_face_75_4vol_a2full.nam?url';

export const FACTORY_NAM_NAME = 'red_face_75_4vol_a2full.nam';

export function parseNamText(text: string, filename: string): NamAssetData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`"${filename}" is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`"${filename}" is not a NAM profile`);
  }
  return { filename, json: text };
}

export async function decodeIrBytes(
  bytes: Uint8Array,
  filename: string,
  ctx?: AudioContext | null,
): Promise<AudioAssetData> {
  try {
    const buffer = decodeAudioFile(bytes, filename);
    return {
      filename,
      samples: buffer.getChannelData(0).slice(),
      samplesR: buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : undefined,
      sampleRate: buffer.sampleRate,
    };
  } catch {
    const decoded = await decodeHostedAudio(bytes, filename, ctx);
    if (!decoded) throw new Error(`Could not decode "${filename}" as audio`);
    return {
      filename,
      samples: decoded.getChannelData(0).slice(),
      samplesR: decoded.numberOfChannels > 1 ? decoded.getChannelData(1).slice() : undefined,
      sampleRate: decoded.sampleRate,
    };
  }
}

export async function loadFactoryNam(): Promise<NamAssetData> {
  if (!factoryNamUrl) throw new Error('Factory NAM profile is not in this checkout');
  const response = await fetch(factoryNamUrl);
  if (!response.ok) throw new Error(`Factory profile failed to load (${response.status})`);
  return parseNamText(await response.text(), FACTORY_NAM_NAME);
}

export function namFilename(material: Material): string | null {
  return ampNamAsset(material)?.filename ?? null;
}

export function namFilenameR(material: Material): string | null {
  return ampNamAssetR(material)?.filename ?? null;
}

export function irFilename(material: Material, kind: string): string | null {
  if (kind === 'amp') return null;
  return irAsset(material)?.filename ?? null;
}

export function sampleFilename(material: Material): string | null {
  return sampleAsset(material)?.filename ?? null;
}

export function wavetableFilename(material: Material): string | null {
  return wavetableAsset(material)?.filename ?? null;
}

export function applyNam(material: Material, asset: NamAssetData): void {
  setAmpNamAsset(material, asset);
}

export function applyNamR(material: Material, asset: NamAssetData): void {
  setAmpNamAssetR(material, asset);
}

export function applyIr(material: Material, kind: string, asset: AudioAssetData): void {
  if (kind === 'amp') return;
  setIrAsset(material, asset);
}

export function applySample(material: Material, asset: AudioAssetData): void {
  setSampleAsset(material, asset);
}

export function applyWavetable(material: Material, asset: AudioAssetData): void {
  setWavetableAsset(material, asset);
}

export function clearNam(material: Material): void {
  material.clearAsset(AMP_ASSET.nam);
}

export function clearNamR(material: Material): void {
  material.clearAsset(AMP_ASSET.namR);
}

export function clearIr(material: Material, kind: string): void {
  if (kind === 'amp') {
    material.clearAsset(AMP_ASSET.ir);
    material.clearAsset(AMP_ASSET.irRef);
    return;
  }
  material.clearAsset(IR_ASSET);
  material.clearAsset(IR_ASSET_REF);
}

export function clearSample(material: Material): void {
  clearSampleAsset(material);
}

export function clearWavetable(material: Material): void {
  clearWavetableAsset(material);
}

export function hasFileSlots(kind: string | null): boolean {
  return kind === 'amp' || kind === 'ir' || kind === 'sampleplayer' || kind === 'wavetable';
}
