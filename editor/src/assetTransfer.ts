import { CRATE_PROTOCOL_VERSION, MESSAGE } from '../../src/collab/protocol';
import type { AssetSlot, PortableAsset } from './assetStore';
import { portableAssetId } from './assetStore';

export const ASSET_CHUNK = 12 * 1024;
export const BLOB_OFFER = 1;
export const BLOB_CHUNK = 2;

const HEADER = 4;

export interface AssetOffer {
  id: string;
  nodeId: string;
  slot: AssetSlot;
  filename: string;
  sampleRate: number;
  byteLength: number;
  chunkCount: number;
}

export interface AssetChunk {
  id: string;
  index: number;
  count: number;
  payload: Uint8Array;
}

const SLOTS: readonly AssetSlot[] = ['nam', 'namR', 'ir', 'sample', 'wavetable'];

export function assetSetKey(assets: readonly Pick<PortableAsset, 'nodeId' | 'slot' | 'filename' | 'bytes'>[]): string {
  return assets
    .map((asset) => `${asset.nodeId}:${asset.slot}:${asset.filename}:${asset.bytes.byteLength}`)
    .sort()
    .join('\n');
}

export function peersNeedingAssets(
  peerIds: readonly string[],
  key: string,
  sent: ReadonlyMap<string, string>,
): string[] {
  return peerIds.filter((id) => sent.get(id) !== key);
}

export function isBlobPacket(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER && bytes[0] === CRATE_PROTOCOL_VERSION && bytes[1] === MESSAGE.blob;
}

function putText(bytes: Uint8Array, offset: number, text: string): number {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength > 65535) throw new Error('asset field too long');
  bytes[offset] = encoded.byteLength & 255;
  bytes[offset + 1] = encoded.byteLength >> 8;
  bytes.set(encoded, offset + 2);
  return offset + 2 + encoded.byteLength;
}

function readText(bytes: Uint8Array, offset: number): { value: string; next: number } | null {
  if (offset + 2 > bytes.length) return null;
  const length = bytes[offset]! + (bytes[offset + 1]! << 8);
  if (offset + 2 + length > bytes.length) return null;
  const value = new TextDecoder().decode(bytes.subarray(offset + 2, offset + 2 + length));
  return { value, next: offset + 2 + length };
}

export function encodeAssetOffer(asset: PortableAsset): Uint8Array {
  const id = portableAssetId(asset);
  const chunkCount = Math.max(1, Math.ceil(asset.bytes.byteLength / ASSET_CHUNK));
  const idBytes = new TextEncoder().encode(id);
  const nodeBytes = new TextEncoder().encode(asset.nodeId);
  const nameBytes = new TextEncoder().encode(asset.filename);
  const bytes = new Uint8Array(
    HEADER + 1 + 2 + idBytes.length + 2 + nodeBytes.length + 1 + 2 + nameBytes.length + 4 + 4 + 2,
  );
  bytes[0] = CRATE_PROTOCOL_VERSION;
  bytes[1] = MESSAGE.blob;
  bytes[2] = 0;
  bytes[3] = 0;
  bytes[4] = BLOB_OFFER;
  let offset = 5;
  offset = putText(bytes, offset, id);
  offset = putText(bytes, offset, asset.nodeId);
  bytes[offset] = SLOTS.indexOf(asset.slot);
  offset += 1;
  offset = putText(bytes, offset, asset.filename);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(offset, asset.sampleRate >>> 0, true);
  view.setUint32(offset + 4, asset.bytes.byteLength >>> 0, true);
  view.setUint16(offset + 8, chunkCount, true);
  return bytes;
}

export function encodeAssetChunk(id: string, index: number, count: number, payload: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(id);
  const bytes = new Uint8Array(HEADER + 1 + 2 + idBytes.length + 2 + 2 + payload.byteLength);
  bytes[0] = CRATE_PROTOCOL_VERSION;
  bytes[1] = MESSAGE.blob;
  bytes[4] = BLOB_CHUNK;
  const offset = putText(bytes, 5, id);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(offset, index, true);
  view.setUint16(offset + 2, count, true);
  bytes.set(payload, offset + 4);
  return bytes;
}

export function decodeAssetOffer(bytes: Uint8Array): AssetOffer | null {
  if (!isBlobPacket(bytes) || bytes[4] !== BLOB_OFFER) return null;
  const id = readText(bytes, 5);
  if (!id) return null;
  const nodeId = readText(bytes, id.next);
  if (!nodeId) return null;
  const slotIndex = bytes[nodeId.next];
  if (slotIndex == null || !SLOTS[slotIndex]) return null;
  const filename = readText(bytes, nodeId.next + 1);
  if (!filename) return null;
  if (filename.next + 10 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    id: id.value,
    nodeId: nodeId.value,
    slot: SLOTS[slotIndex]!,
    filename: filename.value,
    sampleRate: view.getUint32(filename.next, true),
    byteLength: view.getUint32(filename.next + 4, true),
    chunkCount: view.getUint16(filename.next + 8, true),
  };
}

export function decodeAssetChunk(bytes: Uint8Array): AssetChunk | null {
  if (!isBlobPacket(bytes) || bytes[4] !== BLOB_CHUNK) return null;
  const id = readText(bytes, 5);
  if (!id || id.next + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    id: id.value,
    index: view.getUint16(id.next, true),
    count: view.getUint16(id.next + 2, true),
    payload: bytes.subarray(id.next + 4),
  };
}

export function splitAssetBytes(bytes: Uint8Array, chunk = ASSET_CHUNK): Uint8Array[] {
  if (bytes.byteLength === 0) return [bytes];
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    parts.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunk)));
  }
  return parts;
}

export function assembleAsset(offer: AssetOffer, parts: Array<Uint8Array | undefined>): PortableAsset | null {
  if (parts.length !== offer.chunkCount) return null;
  const bytes = new Uint8Array(offer.byteLength);
  let offset = 0;
  for (let i = 0; i < offer.chunkCount; i++) {
    const part = parts[i];
    if (!part) return null;
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  if (offset !== offer.byteLength) return null;
  return {
    nodeId: offer.nodeId,
    slot: offer.slot,
    filename: offer.filename,
    sampleRate: offer.sampleRate,
    bytes,
  };
}
