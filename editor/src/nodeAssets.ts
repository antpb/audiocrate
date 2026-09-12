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
  type AudioMaterial,
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
import {
  FACTORY_KIT_FILES,
  FACTORY_PAD_SAMPLES,
  NUM_PADS,
  applyFactoryKitParams,
  clearDrumPadAsset,
  drumPadAsset,
  setDrumPadAsset,
} from '../../examples/drum/src/index';
import { DRUM_KIT_URLS } from './drumKitAssets';
import { decodeHostedAudio } from './host/decodeAudio';
import factoryNamUrl from '../../examples/amp/wasm/fixtures/red_face_75_4vol_a2full.nam?url';

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

export function namFilename(material: AudioMaterial): string | null {
  return ampNamAsset(material)?.filename ?? null;
}

export function namFilenameR(material: AudioMaterial): string | null {
  return ampNamAssetR(material)?.filename ?? null;
}

export function irFilename(material: AudioMaterial, kind: string): string | null {
  if (kind === 'amp') return null;
  return irAsset(material)?.filename ?? null;
}

export function sampleFilename(material: AudioMaterial): string | null {
  return sampleAsset(material)?.filename ?? null;
}

export function wavetableFilename(material: AudioMaterial): string | null {
  return wavetableAsset(material)?.filename ?? null;
}

export async function attachFactoryNamToBareAmps(
  editor: {
    materials: Map<string, AudioMaterial>;
    kinds: Map<string, string>;
  },
  persist?: (nodeId: string, material: AudioMaterial) => Promise<void>,
  loadNam: () => Promise<NamAssetData> = loadFactoryNam,
): Promise<string[]> {
  const ids: string[] = [];
  for (const [id, material] of editor.materials) {
    if (editor.kinds.get(id) !== 'amp') continue;
    if (namFilename(material)) continue;
    ids.push(id);
  }
  if (ids.length === 0) return [];
  const nam = await loadNam();
  for (const id of ids) {
    const material = editor.materials.get(id);
    if (!material) continue;
    applyNam(material, nam);
    if (persist) await persist(id, material);
  }
  return ids;
}

export function applyNam(material: AudioMaterial, asset: NamAssetData): void {
  setAmpNamAsset(material, asset);
}

export function applyNamR(material: AudioMaterial, asset: NamAssetData): void {
  setAmpNamAssetR(material, asset);
}

export function applyIr(material: AudioMaterial, kind: string, asset: AudioAssetData): void {
  if (kind === 'amp') return;
  setIrAsset(material, asset);
}

export function applySample(material: AudioMaterial, asset: AudioAssetData): void {
  setSampleAsset(material, asset);
}

export function applyWavetable(material: AudioMaterial, asset: AudioAssetData): void {
  setWavetableAsset(material, asset);
}

export function clearNam(material: AudioMaterial): void {
  material.clearAsset(AMP_ASSET.nam);
}

export function clearNamR(material: AudioMaterial): void {
  material.clearAsset(AMP_ASSET.namR);
}

export function clearIr(material: AudioMaterial, kind: string): void {
  if (kind === 'amp') {
    material.clearAsset(AMP_ASSET.ir);
    material.clearAsset(AMP_ASSET.irRef);
    return;
  }
  material.clearAsset(IR_ASSET);
  material.clearAsset(IR_ASSET_REF);
}

export function clearSample(material: AudioMaterial): void {
  clearSampleAsset(material);
}

export function clearWavetable(material: AudioMaterial): void {
  clearWavetableAsset(material);
}

/**
 * One filename per pad, sparse, in pad order.
 *
 * The drum is the one material with a bank of files rather than a slot, so it
 * answers with a list where the others answer with a name.
 */
export function drumPadFilenames(material: AudioMaterial): (string | null)[] {
  return Array.from({ length: NUM_PADS }, (_, pad) => drumPadAsset(material, pad)?.filename ?? null);
}

export function applyDrumPad(material: AudioMaterial, pad: number, asset: AudioAssetData): void {
  setDrumPadAsset(material, pad, asset);
}

/**
 * The factory kit, decoded.
 *
 * Fetched once and shared, because eleven of the sixteen pads are the same
 * five files and decoding each of those three times would be three times the
 * work for the same samples.
 */
let factoryKitPromise: Promise<AudioAssetData[]> | null = null;

export async function loadFactoryDrumKit(ctx?: AudioContext | null): Promise<AudioAssetData[]> {
  if (!factoryKitPromise) {
    factoryKitPromise = (async () => {
      const byFile = new Map<string, AudioAssetData>();
      await Promise.all(
        FACTORY_KIT_FILES.map(async (filename) => {
          const url = DRUM_KIT_URLS[filename];
          if (!url) throw new Error(`"${filename}" is not in this checkout's drum kit assets`);
          const response = await fetch(url);
          if (!response.ok) throw new Error(`"${filename}" failed to load (${response.status})`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          byFile.set(filename, await decodeIrBytes(bytes, filename, ctx));
        }),
      );
      return FACTORY_PAD_SAMPLES.map((filename) => byFile.get(filename)!);
    })();
    // A failed fetch should not poison every later attempt.
    factoryKitPromise.catch(() => {
      factoryKitPromise = null;
    });
  }
  return factoryKitPromise;
}

/** True when no pad has a sample, which is what a drum looks like before a kit. */
export function drumIsEmpty(material: AudioMaterial): boolean {
  for (let pad = 0; pad < NUM_PADS; pad++) {
    if (drumPadAsset(material, pad)) return false;
  }
  return true;
}

export async function applyFactoryDrumKit(material: AudioMaterial, ctx?: AudioContext | null): Promise<void> {
  const assets = await loadFactoryDrumKit(ctx);
  assets.forEach((asset, pad) => setDrumPadAsset(material, pad, asset));
  applyFactoryKitParams(material);
}

/**
 * Loads the factory kit into every drum that has no samples at all.
 *
 * Sixteen empty pads is a node that makes no sound however hard it is played,
 * and a new one has no way to know it is supposed to go looking for files.
 * The plugin seeds a kit when a fresh instance is added; this is the same
 * move. A drum with even one pad loaded is left alone, so nothing a user
 * built is ever overwritten.
 */
export async function attachFactoryKitToBareDrums(
  editor: {
    materials: Map<string, AudioMaterial>;
    kinds: Map<string, string>;
  },
  persist?: (nodeId: string, material: AudioMaterial) => Promise<void>,
  ctx?: AudioContext | null,
): Promise<string[]> {
  const ids: string[] = [];
  for (const [id, material] of editor.materials) {
    if (editor.kinds.get(id) !== 'drum') continue;
    if (!drumIsEmpty(material)) continue;
    ids.push(id);
  }
  if (ids.length === 0) return [];
  const assets = await loadFactoryDrumKit(ctx);
  for (const id of ids) {
    const material = editor.materials.get(id);
    if (!material) continue;
    assets.forEach((asset, pad) => setDrumPadAsset(material, pad, asset));
    applyFactoryKitParams(material);
    if (persist) await persist(id, material);
  }
  return ids;
}

export function clearDrumPad(material: AudioMaterial, pad: number): void {
  clearDrumPadAsset(material, pad);
}

export function hasFileSlots(kind: string | null): boolean {
  return kind === 'amp' || kind === 'ir' || kind === 'sampleplayer' || kind === 'wavetable';
}
