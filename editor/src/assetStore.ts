import { irAsset, sampleAsset, wavetableAsset, type AudioAssetData, type Material } from '../../src/index';
import { ampNamAsset, ampNamAssetR } from './host/ampAssets';
import {
  applyIr,
  applyNam,
  applyNamR,
  applySample,
  applyWavetable,
  irFilename,
  namFilename,
  namFilenameR,
  sampleFilename,
  wavetableFilename,
} from './nodeAssets';
import type { PatchEditor } from './editor';

const DB_NAME = 'crate.patcher.assets';
const STORE = 'nodes';

interface StoredNam {
  kind: 'nam';
  filename: string;
  json: string;
}

interface StoredIr {
  kind: 'ir';
  filename: string;
  samples: ArrayBuffer;
  samplesR?: ArrayBuffer;
  sampleRate: number;
}

interface StoredNode {
  nam?: StoredNam;
  namR?: StoredNam;
  ir?: StoredIr;
  sample?: StoredIr;
  wavetable?: StoredIr;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('asset store open failed'));
  });
}

function run<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('asset store request failed'));
  });
}

async function readNode(nodeId: string): Promise<StoredNode> {
  if (typeof indexedDB === 'undefined') return {};
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    return ((await run(tx.objectStore(STORE).get(nodeId))) as StoredNode | undefined) ?? {};
  } finally {
    db.close();
  }
}

async function writeNode(nodeId: string, record: StoredNode): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    if (!record.nam && !record.namR && !record.ir && !record.sample && !record.wavetable)
      await run(tx.objectStore(STORE).delete(nodeId));
    else await run(tx.objectStore(STORE).put(record, nodeId));
  } finally {
    db.close();
  }
}

function packIr(asset: AudioAssetData): StoredIr {
  return {
    kind: 'ir',
    filename: asset.filename,
    samples: asset.samples.buffer.slice(
      asset.samples.byteOffset,
      asset.samples.byteOffset + asset.samples.byteLength,
    ) as ArrayBuffer,
    samplesR: asset.samplesR
      ? (asset.samplesR.buffer.slice(
          asset.samplesR.byteOffset,
          asset.samplesR.byteOffset + asset.samplesR.byteLength,
        ) as ArrayBuffer)
      : undefined,
    sampleRate: asset.sampleRate,
  };
}

function unpackIr(stored: StoredIr): AudioAssetData {
  return {
    filename: stored.filename,
    samples: new Float32Array(stored.samples),
    samplesR: stored.samplesR ? new Float32Array(stored.samplesR) : undefined,
    sampleRate: stored.sampleRate,
  };
}

export async function persistNodeAssets(nodeId: string, material: Material, kind: string): Promise<void> {
  const nam = namFilename(material);
  const namR = namFilenameR(material);
  const irName = irFilename(material, kind);
  const record: StoredNode = {};
  if (kind === 'amp' && nam) {
    const asset = ampNamAsset(material);
    if (asset) record.nam = { kind: 'nam', filename: asset.filename, json: asset.json };
  }
  if (kind === 'amp' && namR) {
    const asset = ampNamAssetR(material);
    if (asset) record.namR = { kind: 'nam', filename: asset.filename, json: asset.json };
  }
  if (kind === 'ir' && irName) {
    const asset = irAsset(material);
    if (asset) record.ir = packIr(asset);
  }
  if (kind === 'sampleplayer' && sampleFilename(material)) {
    const asset = sampleAsset(material);
    if (asset) record.sample = packIr(asset);
  }
  if (kind === 'wavetable' && wavetableFilename(material)) {
    const asset = wavetableAsset(material);
    if (asset) record.wavetable = packIr(asset);
  }
  await writeNode(nodeId, record);
}

export async function clearStoredNodeAssets(nodeId: string): Promise<void> {
  await writeNode(nodeId, {});
}

export type AssetSlot = 'nam' | 'namR' | 'ir' | 'sample' | 'wavetable';

export interface PortableAsset {
  nodeId: string;
  slot: AssetSlot;
  filename: string;
  sampleRate: number;
  bytes: Uint8Array;
}

export function portableAssetId(asset: Pick<PortableAsset, 'nodeId' | 'slot' | 'filename'>): string {
  return `${asset.nodeId}:${asset.slot}:${asset.filename}`;
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function packAudioBytes(asset: AudioAssetData): Uint8Array {
  const left = new Uint8Array(asset.samples.buffer, asset.samples.byteOffset, asset.samples.byteLength);
  const right = asset.samplesR
    ? new Uint8Array(asset.samplesR.buffer, asset.samplesR.byteOffset, asset.samplesR.byteLength)
    : null;
  const bytes = new Uint8Array(12 + left.byteLength + (right?.byteLength ?? 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, asset.sampleRate >>> 0, true);
  view.setUint32(4, asset.samples.length >>> 0, true);
  bytes[8] = right ? 1 : 0;
  bytes.set(left, 12);
  if (right) bytes.set(right, 12 + left.byteLength);
  return bytes;
}

function readF32(bytes: Uint8Array, offset: number, count: number): Float32Array {
  const samples = new Float32Array(count);
  new Uint8Array(samples.buffer).set(bytes.subarray(offset, offset + count * 4));
  return samples;
}

export function unpackAudioBytes(bytes: Uint8Array, filename: string): AudioAssetData {
  if (bytes.byteLength < 12) throw new Error('audio asset is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(0, true);
  const count = view.getUint32(4, true);
  const hasR = bytes[8] === 1;
  const need = 12 + count * 4 * (hasR ? 2 : 1);
  if (bytes.byteLength < need) throw new Error('audio asset is truncated');
  const samples = readF32(bytes, 12, count);
  const samplesR = hasR ? readF32(bytes, 12 + count * 4, count) : undefined;
  return {
    filename,
    samples,
    samplesR,
    sampleRate,
  };
}

export function collectPortableAssets(editor: PatchEditor): PortableAsset[] {
  const assets: PortableAsset[] = [];
  for (const [nodeId, material] of editor.materials) {
    const kind = editor.kinds.get(nodeId);
    if (kind === 'amp') {
      const nam = ampNamAsset(material);
      if (nam) {
        assets.push({ nodeId, slot: 'nam', filename: nam.filename, sampleRate: 0, bytes: encodeUtf8(nam.json) });
      }
      const namR = ampNamAssetR(material);
      if (namR) {
        assets.push({ nodeId, slot: 'namR', filename: namR.filename, sampleRate: 0, bytes: encodeUtf8(namR.json) });
      }
    }
    if (kind === 'ir') {
      const asset = irAsset(material);
      if (asset) {
        assets.push({ nodeId, slot: 'ir', filename: asset.filename, sampleRate: asset.sampleRate, bytes: packAudioBytes(asset) });
      }
    }
    if (kind === 'sampleplayer') {
      const asset = sampleAsset(material);
      if (asset) {
        assets.push({
          nodeId,
          slot: 'sample',
          filename: asset.filename,
          sampleRate: asset.sampleRate,
          bytes: packAudioBytes(asset),
        });
      }
    }
    if (kind === 'wavetable') {
      const asset = wavetableAsset(material);
      if (asset) {
        assets.push({
          nodeId,
          slot: 'wavetable',
          filename: asset.filename,
          sampleRate: asset.sampleRate,
          bytes: packAudioBytes(asset),
        });
      }
    }
  }
  return assets;
}

export async function installPortableAsset(editor: PatchEditor, asset: PortableAsset): Promise<void> {
  const material = editor.materials.get(asset.nodeId);
  const kind = editor.kinds.get(asset.nodeId);
  if (!material || !kind) return;
  if (asset.slot === 'nam' && kind === 'amp') {
    applyNam(material, { filename: asset.filename, json: new TextDecoder().decode(asset.bytes) });
    await persistNodeAssets(asset.nodeId, material, kind);
    return;
  }
  if (asset.slot === 'namR' && kind === 'amp') {
    applyNamR(material, { filename: asset.filename, json: new TextDecoder().decode(asset.bytes) });
    await persistNodeAssets(asset.nodeId, material, kind);
    return;
  }
  const audio = unpackAudioBytes(asset.bytes, asset.filename);
  if (asset.slot === 'ir' && kind === 'ir') applyIr(material, kind, audio);
  else if (asset.slot === 'sample' && kind === 'sampleplayer') applySample(material, audio);
  else if (asset.slot === 'wavetable' && kind === 'wavetable') applyWavetable(material, audio);
  else return;
  await persistNodeAssets(asset.nodeId, material, kind);
}

export async function hydratePatchAssets(editor: PatchEditor): Promise<void> {
  for (const [nodeId, material] of editor.materials) {
    const kind = editor.kinds.get(nodeId);
    if (kind !== 'amp' && kind !== 'ir' && kind !== 'sampleplayer' && kind !== 'wavetable') continue;
    const stored = await readNode(nodeId);
    if (kind === 'amp' && stored.nam) applyNam(material, stored.nam);
    if (kind === 'amp' && stored.namR) applyNamR(material, stored.namR);
    if (kind === 'ir' && stored.ir) applyIr(material, kind, unpackIr(stored.ir));
    if (kind === 'sampleplayer' && stored.sample) applySample(material, unpackIr(stored.sample));
    if (kind === 'wavetable' && stored.wavetable) applyWavetable(material, unpackIr(stored.wavetable));
  }
}
