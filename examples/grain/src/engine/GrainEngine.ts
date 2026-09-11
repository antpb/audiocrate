import createGrainFxModule, { type GrainFxEmscriptenModule } from '../../wasm/dist/grain_fx.js';
import { grainParams } from '../grainMaterial';
import type { GrainProcessor } from './GrainProcessor';

export interface GrainEngineOptions {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}

/**
 * The grain kernel times process() with std::chrono. Emscripten maps that
 * to performance.now(), which AudioWorklet's isolated global does not have.
 */
function ensurePerformanceNow(): void {
  const g = globalThis as unknown as { performance?: { now(): number } };
  if (typeof g.performance?.now === 'function') return;
  const origin = Date.now();
  g.performance = { now: () => Date.now() - origin };
}

let modulePromise: Promise<GrainFxEmscriptenModule> | null = null;

export function initGrainFxModule(options: GrainEngineOptions = {}): Promise<GrainFxEmscriptenModule> {
  if (modulePromise) return modulePromise;
  ensurePerformanceNow();
  modulePromise = createGrainFxModule({
    wasmBinary: options.wasmBinary,
    locateFile: options.locateFile ?? ((path) => path),
  });
  return modulePromise;
}

export function resetGrainFxModule(): void {
  modulePromise = null;
}

const PARAM_ADDRESSES: Array<[string, number]> = Object.entries(grainParams)
  .filter(([, desc]) => desc.address !== undefined)
  .map(([name, desc]) => [name, desc.address!]);

export class GrainFxModel implements GrainProcessor {
  private inLPtr = 0;
  private inRPtr = 0;
  private outLPtr = 0;
  private outRPtr = 0;
  private capacity = 0;

  constructor(
    private readonly mod: GrainFxEmscriptenModule,
    private readonly handle: number,
  ) {}

  private ensureCapacity(frames: number): void {
    if (this.capacity >= frames) return;
    this.freeBuffers();
    const bytes = frames * 4;
    this.inLPtr = this.mod._malloc(bytes);
    this.inRPtr = this.mod._malloc(bytes);
    this.outLPtr = this.mod._malloc(bytes);
    this.outRPtr = this.mod._malloc(bytes);
    this.capacity = frames;
  }

  private freeBuffers(): void {
    if (this.inLPtr) this.mod._free(this.inLPtr);
    if (this.inRPtr) this.mod._free(this.inRPtr);
    if (this.outLPtr) this.mod._free(this.outLPtr);
    if (this.outRPtr) this.mod._free(this.outRPtr);
    this.inLPtr = this.inRPtr = this.outLPtr = this.outRPtr = 0;
    this.capacity = 0;
  }

  applyParams(params: Record<string, number>): void {
    for (const [name, address] of PARAM_ADDRESSES) {
      const value = params[name];
      if (value !== undefined) this.mod._grainfx_set_param(this.handle, address, value);
    }
  }

  setHostBpm(bpm: number): void {
    this.mod._grainfx_set_host_bpm(this.handle, bpm);
  }

  process(
    inputL: Float32Array,
    inputR: Float32Array | null,
    outputL: Float32Array,
    outputR: Float32Array | null,
  ): void {
    const frames = outputL.length;
    this.ensureCapacity(frames);
    this.mod.HEAPF32.set(inputL.subarray(0, frames), this.inLPtr >> 2);
    const right = inputR && inputR.length >= frames ? inputR : inputL;
    this.mod.HEAPF32.set(right.subarray(0, frames), this.inRPtr >> 2);
    this.mod._grainfx_process(this.handle, this.inLPtr, this.inRPtr, this.outLPtr, this.outRPtr, frames);
    outputL.set(this.mod.HEAPF32.subarray(this.outLPtr >> 2, (this.outLPtr >> 2) + frames));
    if (outputR) {
      outputR.set(this.mod.HEAPF32.subarray(this.outRPtr >> 2, (this.outRPtr >> 2) + frames));
    }
  }

  loadLoop(samplesL: Float32Array, samplesR?: Float32Array | null): void {
    const count = samplesL.length;
    const lPtr = this.mod._malloc(count * 4);
    this.mod.HEAPF32.set(samplesL, lPtr >> 2);
    let rPtr = 0;
    if (samplesR && samplesR.length >= count) {
      rPtr = this.mod._malloc(count * 4);
      this.mod.HEAPF32.set(samplesR.subarray(0, count), rPtr >> 2);
    }
    this.mod._grainfx_load_loop(this.handle, lPtr, rPtr, count);
    this.mod._free(lPtr);
    if (rPtr) this.mod._free(rPtr);
  }

  releaseLoop(): void {
    this.mod._grainfx_release_loop(this.handle);
  }

  noteOn(note: number, velocity: number): void {
    this.mod._grainfx_note_on(this.handle, note, velocity);
  }

  noteOff(note: number): void {
    this.mod._grainfx_note_off(this.handle, note);
  }

  controlChange(cc: number, on: boolean): void {
    this.mod._grainfx_cc(this.handle, cc, on ? 1 : 0);
  }

  dispose(): void {
    this.mod._grainfx_destroy(this.handle);
    this.freeBuffers();
  }
}

export async function createGrainFx(
  sampleRate: number,
  options: GrainEngineOptions = {},
): Promise<GrainFxModel> {
  const mod = await initGrainFxModule(options);
  const handle = mod._grainfx_create(sampleRate);
  if (!handle) {
    throw new Error(`grain FX create failed: ${mod.UTF8ToString(mod._grainfx_last_error())}`);
  }
  return new GrainFxModel(mod, handle);
}
