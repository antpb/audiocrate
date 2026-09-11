import createAmpFxModule, { type AmpFxEmscriptenModule } from '../../wasm/dist/amp_fx.js';
import { ampParams } from '../ampMaterial';
import type { AmpFxProcessor } from './AmpFxProcessor';

export interface AmpFxEngineOptions {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}

let modulePromise: Promise<AmpFxEmscriptenModule> | null = null;

export function initAmpFxModule(options: AmpFxEngineOptions = {}): Promise<AmpFxEmscriptenModule> {
  if (modulePromise) return modulePromise;
  modulePromise = createAmpFxModule({
    wasmBinary: options.wasmBinary,
    locateFile: options.locateFile ?? ((path) => path),
  });
  return modulePromise;
}

export function resetAmpFxModule(): void {
  modulePromise = null;
}

const PARAM_ADDRESSES: Array<[string, number]> = Object.entries(ampParams)
  .filter(([, desc]) => desc.address !== undefined)
  .map(([name, desc]) => [name, desc.address!]);

export class AmpFxModel implements AmpFxProcessor {
  private bufPtr = 0;
  private capacity = 0;

  constructor(
    private readonly mod: AmpFxEmscriptenModule,
    private readonly handle: number,
  ) {}

  private ensureCapacity(frames: number): void {
    if (this.capacity >= frames) return;
    if (this.bufPtr) this.mod._free(this.bufPtr);
    this.bufPtr = this.mod._malloc(frames * 4);
    this.capacity = frames;
  }

  private runInPlace(buffer: Float32Array, fn: (ptr: number, frames: number) => void): void {
    const frames = buffer.length;
    this.ensureCapacity(frames);
    this.mod.HEAPF32.set(buffer, this.bufPtr >> 2);
    fn(this.bufPtr, frames);
    buffer.set(this.mod.HEAPF32.subarray(this.bufPtr >> 2, (this.bufPtr >> 2) + frames));
  }

  applyParams(params: Record<string, number>): void {
    for (const [name, address] of PARAM_ADDRESSES) {
      const value = params[name];
      if (value !== undefined) this.mod._ampfx_set_param(this.handle, address, value);
    }
  }

  setHostBpm(bpm: number): void {
    this.mod._ampfx_set_host_bpm(this.handle, bpm);
  }

  setIR(samples: Float32Array): void {
    const ptr = this.mod._malloc(samples.length * 4);
    this.mod.HEAPF32.set(samples, ptr >> 2);
    this.mod._ampfx_set_ir(this.handle, ptr, samples.length);
    this.mod._free(ptr);
  }

  clearIR(): void {
    this.mod._ampfx_clear_ir(this.handle);
  }

  latencySamples(): number {
    return this.mod._ampfx_latency_samples(this.handle);
  }

  processPre(buffer: Float32Array): void {
    this.runInPlace(buffer, (ptr, frames) => this.mod._ampfx_process_pre(this.handle, ptr, frames));
  }

  processPost(buffer: Float32Array): void {
    this.runInPlace(buffer, (ptr, frames) => this.mod._ampfx_process_post(this.handle, ptr, frames));
  }

  dispose(): void {
    this.mod._ampfx_destroy(this.handle);
    if (this.bufPtr) {
      this.mod._free(this.bufPtr);
      this.bufPtr = 0;
      this.capacity = 0;
    }
  }
}

export async function createAmpFx(
  sampleRate: number,
  options: AmpFxEngineOptions = {},
): Promise<AmpFxModel> {
  const mod = await initAmpFxModule(options);
  const handle = mod._ampfx_create(sampleRate);
  if (!handle) {
    throw new Error(`amp FX create failed: ${mod.UTF8ToString(mod._ampfx_last_error())}`);
  }
  return new AmpFxModel(mod, handle);
}
