import createSynthFxModule, { type SynthFxEmscriptenModule } from '../../wasm/dist/synth_fx.js';
import { synthParams } from '../synthMaterial';
import type { SynthProcessor } from './SynthProcessor';

export interface SynthEngineOptions {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}

let modulePromise: Promise<SynthFxEmscriptenModule> | null = null;

export function initSynthFxModule(options: SynthEngineOptions = {}): Promise<SynthFxEmscriptenModule> {
  if (modulePromise) return modulePromise;
  modulePromise = createSynthFxModule({
    wasmBinary: options.wasmBinary,
    locateFile: options.locateFile ?? ((path) => path),
  });
  return modulePromise;
}

export function resetSynthFxModule(): void {
  modulePromise = null;
}

const PARAM_ADDRESSES: Array<[string, number]> = Object.entries(synthParams)
  .filter(([, desc]) => desc.address !== undefined)
  .map(([name, desc]) => [name, desc.address!]);

export class SynthFxModel implements SynthProcessor {
  private outLPtr = 0;
  private outRPtr = 0;
  private capacity = 0;

  constructor(
    private readonly mod: SynthFxEmscriptenModule,
    private readonly handle: number,
  ) {}

  private ensureCapacity(frames: number): void {
    if (this.capacity >= frames) return;
    this.freeBuffers();
    const bytes = frames * 4;
    this.outLPtr = this.mod._malloc(bytes);
    this.outRPtr = this.mod._malloc(bytes);
    this.capacity = frames;
  }

  private freeBuffers(): void {
    if (this.outLPtr) this.mod._free(this.outLPtr);
    if (this.outRPtr) this.mod._free(this.outRPtr);
    this.outLPtr = this.outRPtr = 0;
    this.capacity = 0;
  }

  applyParams(params: Record<string, number>): void {
    for (const [name, address] of PARAM_ADDRESSES) {
      const value = params[name];
      if (value !== undefined) this.mod._synthfx_set_param(this.handle, address, value);
    }
  }

  setHostBpm(bpm: number): void {
    this.mod._synthfx_set_host_bpm(this.handle, bpm);
  }

  process(outputL: Float32Array, outputR: Float32Array | null): void {
    const frames = outputL.length;
    this.ensureCapacity(frames);
    this.mod._synthfx_process(this.handle, this.outLPtr, this.outRPtr, frames);
    outputL.set(this.mod.HEAPF32.subarray(this.outLPtr >> 2, (this.outLPtr >> 2) + frames));
    if (outputR) {
      outputR.set(this.mod.HEAPF32.subarray(this.outRPtr >> 2, (this.outRPtr >> 2) + frames));
    }
  }

  noteOn(note: number, velocity: number): void {
    this.mod._synthfx_note_on(this.handle, note, velocity);
  }

  noteOff(note: number): void {
    this.mod._synthfx_note_off(this.handle, note);
  }

  allNotesOff(): void {
    this.mod._synthfx_all_notes_off(this.handle);
  }

  setIRSlot(slot: number, samples: Float32Array): void {
    const ptr = this.mod._malloc(samples.length * 4);
    this.mod.HEAPF32.set(samples, ptr >> 2);
    this.mod._synthfx_set_ir_slot(this.handle, slot, ptr, samples.length);
    this.mod._free(ptr);
  }

  clearIRSlot(slot: number): void {
    this.mod._synthfx_clear_ir_slot(this.handle, slot);
  }

  dispose(): void {
    this.mod._synthfx_destroy(this.handle);
    this.freeBuffers();
  }
}

export async function createSynthFx(
  sampleRate: number,
  options: SynthEngineOptions = {},
): Promise<SynthFxModel> {
  const mod = await initSynthFxModule(options);
  const handle = mod._synthfx_create(sampleRate);
  if (!handle) {
    throw new Error(`synth FX create failed: ${mod.UTF8ToString(mod._synthfx_last_error())}`);
  }
  return new SynthFxModel(mod, handle);
}
