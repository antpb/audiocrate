import createNamModule, { type NamEmscriptenModule } from '../../wasm/dist/nam.js';
import type { NamProcessor } from './NamProcessor';

export interface NamEngineOptions {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}

let modulePromise: Promise<NamEmscriptenModule> | null = null;

export function initNamModule(options: NamEngineOptions = {}): Promise<NamEmscriptenModule> {
  if (modulePromise) return modulePromise;
  modulePromise = createNamModule({
    wasmBinary: options.wasmBinary,
    locateFile: options.locateFile ?? ((path) => path),
  });
  return modulePromise;
}

/** Drop the cached module so a worklet / test can start clean. */
export function resetNamModule(): void {
  modulePromise = null;
}

export class NamModel implements NamProcessor {
  readonly architecture: string;
  readonly a2Fast: boolean;
  readonly a2Channels: number;
  private inPtr = 0;
  private outPtr = 0;
  private capacity = 0;

  constructor(
    private readonly mod: NamEmscriptenModule,
    private readonly handle: number,
  ) {
    this.architecture = mod.UTF8ToString(mod._nam_architecture(handle));
    this.a2Fast = mod._nam_is_a2_fast(handle) !== 0;
    this.a2Channels = mod._nam_a2_channels(handle);
  }

  private ensureCapacity(frames: number): void {
    if (this.capacity >= frames) return;
    if (this.inPtr) {
      this.mod._free(this.inPtr);
      this.mod._free(this.outPtr);
    }
    this.inPtr = this.mod._malloc(frames * 4);
    this.outPtr = this.mod._malloc(frames * 4);
    this.capacity = frames;
  }

  processSample(x: number): number {
    this.ensureCapacity(1);
    this.mod.HEAPF32[this.inPtr >> 2] = x;
    this.mod._nam_process(this.handle, this.inPtr, this.outPtr, 1);
    return this.mod.HEAPF32[this.outPtr >> 2]!;
  }

  processBlock(input: Float32Array, output: Float32Array): void {
    const frames = input.length;
    this.ensureCapacity(frames);
    this.mod.HEAPF32.set(input, this.inPtr >> 2);
    this.mod._nam_process(this.handle, this.inPtr, this.outPtr, frames);
    output.set(this.mod.HEAPF32.subarray(this.outPtr >> 2, (this.outPtr >> 2) + frames));
  }

  dispose(): void {
    this.mod._nam_destroy(this.handle);
    if (this.inPtr) {
      this.mod._free(this.inPtr);
      this.mod._free(this.outPtr);
      this.inPtr = 0;
      this.outPtr = 0;
      this.capacity = 0;
    }
  }
}

export async function createNamModel(
  json: string,
  sampleRate: number,
  maxFrames = 128,
  options: NamEngineOptions = {},
): Promise<NamModel> {
  const mod = await initNamModule(options);
  const bytes = mod.lengthBytesUTF8(json) + 1;
  const ptr = mod._malloc(bytes);
  mod.stringToUTF8(json, ptr, bytes);
  const handle = mod._nam_create(ptr, sampleRate, maxFrames);
  mod._free(ptr);
  if (!handle) {
    throw new Error(`NAM load failed: ${mod.UTF8ToString(mod._nam_last_error())}`);
  }
  return new NamModel(mod, handle);
}
