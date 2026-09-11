import createSpaceReverbModule, { type SpaceReverbEmscriptenModule } from '../../wasm/dist/space_reverb.js';
import { spaceReverbParams } from '../spaceReverbMaterial';
import type { SpaceReverbProcessor } from './SpaceReverbProcessor';

export interface SpaceReverbEngineOptions {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}

let modulePromise: Promise<SpaceReverbEmscriptenModule> | null = null;

export function initSpaceReverbModule(
  options: SpaceReverbEngineOptions = {},
): Promise<SpaceReverbEmscriptenModule> {
  if (modulePromise) return modulePromise;
  modulePromise = createSpaceReverbModule({
    wasmBinary: options.wasmBinary,
    locateFile: options.locateFile ?? ((path) => path),
  });
  return modulePromise;
}

export function resetSpaceReverbModule(): void {
  modulePromise = null;
}

const PARAM_ADDRESSES: Array<[string, number]> = Object.entries(spaceReverbParams)
  .filter(([, desc]) => desc.address !== undefined)
  .map(([name, desc]) => [name, desc.address!]);

export class SpaceReverbModel implements SpaceReverbProcessor {
  private bufPtr = 0;
  private capacity = 0;

  constructor(
    private readonly mod: SpaceReverbEmscriptenModule,
    private readonly handle: number,
  ) {}

  private ensureCapacity(frames: number): void {
    if (this.capacity >= frames) return;
    if (this.bufPtr) this.mod._free(this.bufPtr);
    this.bufPtr = this.mod._malloc(frames * 4);
    this.capacity = frames;
  }

  applyParams(params: Record<string, number>): void {
    for (const [name, address] of PARAM_ADDRESSES) {
      const value = params[name];
      if (value !== undefined) this.mod._spacereverb_set_param(this.handle, address, value);
    }
  }

  process(buffer: Float32Array): void {
    const frames = buffer.length;
    this.ensureCapacity(frames);
    this.mod.HEAPF32.set(buffer, this.bufPtr >> 2);
    this.mod._spacereverb_process(this.handle, this.bufPtr, frames);
    buffer.set(this.mod.HEAPF32.subarray(this.bufPtr >> 2, (this.bufPtr >> 2) + frames));
  }

  dispose(): void {
    this.mod._spacereverb_destroy(this.handle);
    if (this.bufPtr) {
      this.mod._free(this.bufPtr);
      this.bufPtr = 0;
      this.capacity = 0;
    }
  }
}

export async function createSpaceReverb(
  sampleRate: number,
  options: SpaceReverbEngineOptions = {},
): Promise<SpaceReverbModel> {
  const mod = await initSpaceReverbModule(options);
  const handle = mod._spacereverb_create(sampleRate);
  if (!handle) {
    throw new Error(`space reverb create failed: ${mod.UTF8ToString(mod._spacereverb_last_error())}`);
  }
  return new SpaceReverbModel(mod, handle);
}
