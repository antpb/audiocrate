import {
  type AudioStorage,
  type AudioStoragePutOptions,
  type AudioStorageRef,
} from './AudioStorage';
import { bytesToBase64, sliceChunks } from './bytesToBase64';

/** Same 5 MiB slice the world-API build/media clients use. */
export const CHUNKED_HTTP_CHUNK_SIZE = 5 * 1024 * 1024;

export interface ChunkedHttpAudioStorageOptions {
  apiBase: string;
  authorization: string;
  chunkSize?: number;
  chunkPath?: string;
  completePath?: string;
  extraFields?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

/**
 * Chunked JSON+base64 upload, matching `/api/user/media-upload-chunk` and
 * `/api/build/upload-chunk`: 1-based `chunkNumber`, then `upload-complete`,
 * then `fileUrl` for later `get`.
 */
export class ChunkedHttpAudioStorage implements AudioStorage {
  private readonly apiBase: string;
  private readonly authorization: string;
  private readonly chunkSize: number;
  private readonly chunkPath: string;
  private readonly completePath: string;
  private readonly extraFields: Record<string, unknown>;
  private readonly fetchImpl: typeof fetch;
  private readonly urls = new Map<string, string>();

  constructor(options: ChunkedHttpAudioStorageOptions) {
    this.apiBase = options.apiBase.replace(/\/$/, '');
    this.authorization = options.authorization;
    this.chunkSize = options.chunkSize ?? CHUNKED_HTTP_CHUNK_SIZE;
    this.chunkPath = options.chunkPath ?? '/api/user/media-upload-chunk';
    this.completePath = options.completePath ?? '/api/user/media-upload-complete';
    this.extraFields = options.extraFields ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async put(key: string, bytes: Uint8Array, _options?: AudioStoragePutOptions): Promise<AudioStorageRef> {
    const fileName = key.replace(/^.*[/\\]/, '') || 'audio.bin';
    const chunks = sliceChunks(bytes, this.chunkSize);
    const totalChunks = chunks.length;
    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    for (let i = 0; i < chunks.length; i++) {
      const response = await this.post(this.chunkPath, {
        fileName,
        fileData: bytesToBase64(chunks[i]!),
        chunkNumber: i + 1,
        totalChunks,
        uploadId,
        ...this.extraFields,
      });
      if (!response.ok) {
        throw new Error(`audio chunk ${i + 1}/${totalChunks} failed: ${response.status} ${await response.text()}`);
      }
    }

    const complete = await this.post(this.completePath, {
      fileName,
      totalChunks,
      uploadId,
      fileSize: bytes.byteLength,
      ...this.extraFields,
    });
    if (!complete.ok) {
      throw new Error(`audio upload complete failed: ${complete.status} ${await complete.text()}`);
    }
    const body = (await complete.json()) as { fileUrl?: string };
    const url = typeof body.fileUrl === 'string' ? body.fileUrl : undefined;
    if (url) this.urls.set(key, url);
    return { key, size: bytes.byteLength, url };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const url = this.urls.get(key);
    if (!url) return null;
    const response = await this.fetchImpl(url);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  }

  resolveUrl(key: string): string | null {
    return this.urls.get(key) ?? null;
  }

  hasSync(key: string): boolean {
    return this.urls.has(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.urls.has(key);
  }

  async delete(key: string): Promise<void> {
    this.urls.delete(key);
  }

  keys(): string[] {
    return [...this.urls.keys()];
  }

  private post(path: string, body: Record<string, unknown>): Promise<Response> {
    return this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authorization,
      },
      body: JSON.stringify(body),
    });
  }
}
