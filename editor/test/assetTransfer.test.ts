import { describe, expect, it } from 'vitest';
import { packAudioBytes, unpackAudioBytes, type PortableAsset } from '../src/assetStore';
import {
  ASSET_CHUNK,
  assembleAsset,
  decodeAssetChunk,
  decodeAssetOffer,
  encodeAssetChunk,
  encodeAssetOffer,
  splitAssetBytes,
  assetSetKey,
  peersNeedingAssets,
} from '../src/assetTransfer';

describe('portable audio bytes', () => {
  it('round-trips a stereo buffer', () => {
    const left = new Float32Array([0.1, -0.2, 0.3]);
    const right = new Float32Array([0.4, 0.5, 0.6]);
    const packed = packAudioBytes({
      filename: 'room.wav',
      sampleRate: 48000,
      samples: left,
      samplesR: right,
    });
    const unpacked = unpackAudioBytes(packed, 'room.wav');
    expect(unpacked.sampleRate).toBe(48000);
    expect([...unpacked.samples]).toEqual([...left]);
    expect([...(unpacked.samplesR ?? [])]).toEqual([...right]);
    const shifted = new Uint8Array(packed.byteLength + 1);
    shifted.set(packed, 1);
    const fromView = unpackAudioBytes(shifted.subarray(1), 'room.wav');
    expect([...fromView.samples]).toEqual([...left]);
  });
});

describe('asset transfer packets', () => {
  const asset: PortableAsset = {
    nodeId: 'ir1',
    slot: 'ir',
    filename: 'room.wav',
    sampleRate: 44100,
    bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  };

  it('round-trips an offer', () => {
    const offer = decodeAssetOffer(encodeAssetOffer(asset))!;
    expect(offer.nodeId).toBe('ir1');
    expect(offer.slot).toBe('ir');
    expect(offer.filename).toBe('room.wav');
    expect(offer.sampleRate).toBe(44100);
    expect(offer.byteLength).toBe(10);
    expect(offer.chunkCount).toBe(1);
  });

  it('round-trips an offer with a long filename', () => {
    const long = { ...asset, filename: `${'room-'.repeat(40)}.wav` };
    const offer = decodeAssetOffer(encodeAssetOffer(long))!;
    expect(offer.filename).toBe(long.filename);
    expect(offer.id).toBe(`${long.nodeId}:${long.slot}:${long.filename}`);
  });

  it('splits, sends, and reassembles across chunks', () => {
    const parts = splitAssetBytes(asset.bytes, 3);
    expect(parts.map((part) => [...part])).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]]);
    const offer = decodeAssetOffer(encodeAssetOffer({ ...asset, bytes: asset.bytes }))!;
    const received: Uint8Array[] = [];
    parts.forEach((part, index) => {
      const packet = encodeAssetChunk(offer.id, index, parts.length, part);
      const decoded = decodeAssetChunk(packet)!;
      received[decoded.index] = decoded.payload;
    });
    const assembled = assembleAsset({ ...offer, chunkCount: parts.length }, received)!;
    expect([...assembled.bytes]).toEqual([...asset.bytes]);
  });

  it('keeps chunks under the session payload budget', () => {
    expect(ASSET_CHUNK).toBeLessThan(16000);
  });

  it('skips peers who already received the same asset set', () => {
    const key = assetSetKey([asset]);
    const sent = new Map([['peer-b', key]]);
    expect(peersNeedingAssets(['peer-a', 'peer-b'], key, sent)).toEqual(['peer-a']);
    expect(peersNeedingAssets(['peer-b'], key, sent)).toEqual([]);
  });
});
