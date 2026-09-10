import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryAudioStorage,
  getAudioStorage,
  resetAudioStorage,
  setAudioStorage,
} from '../../src/storage/AudioStorage';
import { ChunkedHttpAudioStorage } from '../../src/storage/ChunkedHttpAudioStorage';
import { bytesToBase64, sliceChunks } from '../../src/storage/bytesToBase64';

afterEach(() => {
  resetAudioStorage();
});

describe('MemoryAudioStorage', () => {
  it('is the default layer', async () => {
    const stored = await getAudioStorage().put('/a.wav', new Uint8Array([1, 2, 3]));
    expect(stored.size).toBe(3);
    expect(await getAudioStorage().get('/a.wav')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('setAudioStorage replaces the default', async () => {
    const custom = new MemoryAudioStorage();
    setAudioStorage(custom);
    await getAudioStorage().put('/b.wav', new Uint8Array([9]));
    expect(custom.getSync('/b.wav')).toEqual(new Uint8Array([9]));
    expect(custom.keys()).toEqual(['/b.wav']);
  });
});

describe('sliceChunks / bytesToBase64', () => {
  it('splits on the 5MB world-API size and base64-encodes a slice', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const chunks = sliceChunks(bytes, 2);
    expect(chunks.map((c) => [...c])).toEqual([[1, 2], [3, 4], [5]]);
    expect(bytesToBase64(new Uint8Array([1, 2, 3]))).toBe('AQID');
  });
});

describe('ChunkedHttpAudioStorage', () => {
  it('uploads 1-based chunks then complete, and get() fetches fileUrl', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.includes('upload-complete')) {
        return new Response(JSON.stringify({ fileUrl: 'https://cdn.example/users/a/media/1-take.wav' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('https://cdn.example/')) {
        return new Response(new Uint8Array([9, 8, 7]));
      }
      return new Response(JSON.stringify({ success: true, isComplete: true }), { status: 200 });
    };

    const storage = new ChunkedHttpAudioStorage({
      apiBase: 'https://api.example',
      authorization: 'Bearer secret',
      chunkSize: 2,
      extraFields: { userId: 'a', fileType: 'audio' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const ref = await storage.put('/crate/take.wav', new Uint8Array([1, 2, 3]));
    expect(ref.url).toBe('https://cdn.example/users/a/media/1-take.wav');
    expect(calls.filter((c) => c.url.endsWith('upload-chunk'))).toHaveLength(2);
    expect(calls[0]!.body.chunkNumber).toBe(1);
    expect(calls[0]!.body.totalChunks).toBe(2);
    expect(calls[0]!.body.fileType).toBe('audio');
    expect(calls[0]!.body.fileData).toBe(bytesToBase64(new Uint8Array([1, 2])));
    expect(calls.some((c) => c.url.endsWith('upload-complete'))).toBe(true);

    const pulled = await storage.get('/crate/take.wav');
    expect(pulled).toEqual(new Uint8Array([9, 8, 7]));
  });
});
