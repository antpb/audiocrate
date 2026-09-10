/**
 * Optional audio store for crate hosts.
 *
 * Default is in-memory (`MemoryAudioStorage`). A host can `setAudioStorage`
 * to something else: OPFS, a chunked HTTP upload (the world-API protocol),
 * or any object that implements this interface. Import writes through
 * `put`. Play / waveforms read through `get`.
 */

export interface AudioStorageRef {
  key: string;
  size: number;
  url?: string;
}

export interface AudioStoragePutOptions {
  contentType?: string;
}

export interface AudioStorage {
  put(key: string, bytes: Uint8Array, options?: AudioStoragePutOptions): Promise<AudioStorageRef>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  delete?(key: string): Promise<void>;
  resolveUrl?(key: string): string | null;
  getSync?(key: string): Uint8Array | null;
  hasSync?(key: string): boolean;
  keys(): string[];
}

export class MemoryAudioStorage implements AudioStorage {
  readonly files: Map<string, Uint8Array>;

  constructor(files?: Map<string, Uint8Array>) {
    this.files = files ?? new Map();
  }

  async put(key: string, bytes: Uint8Array): Promise<AudioStorageRef> {
    this.files.set(key, bytes);
    return { key, size: bytes.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key) ?? null;
  }

  getSync(key: string): Uint8Array | null {
    return this.files.get(key) ?? null;
  }

  hasSync(key: string): boolean {
    return this.files.has(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(key);
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  keys(): string[] {
    return [...this.files.keys()];
  }
}

const defaultStorage = new MemoryAudioStorage();
let current: AudioStorage = defaultStorage;

export function getAudioStorage(): AudioStorage {
  return current;
}

export function setAudioStorage(layer: AudioStorage): void {
  current = layer;
}

export function resetAudioStorage(): void {
  current = new MemoryAudioStorage();
}

export function isMemoryAudioStorage(layer: AudioStorage): layer is MemoryAudioStorage {
  return layer instanceof MemoryAudioStorage;
}
