export interface SynthFxEmscriptenModule {
  HEAPF32: Float32Array;
  UTF8ToString(ptr: number): string;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _synthfx_create(sampleRate: number): number;
  _synthfx_destroy(handle: number): void;
  _synthfx_set_param(handle: number, address: number, value: number): void;
  _synthfx_set_host_bpm(handle: number, bpm: number): void;
  _synthfx_process(handle: number, outL: number, outR: number, frames: number): void;
  _synthfx_note_on(handle: number, note: number, velocity: number): void;
  _synthfx_note_off(handle: number, note: number): void;
  _synthfx_all_notes_off(handle: number): void;
  _synthfx_set_ir_slot(handle: number, slot: number, dataPtr: number, count: number): void;
  _synthfx_clear_ir_slot(handle: number, slot: number): void;
  _synthfx_last_error(): number;
}

export default function createSynthFxModule(opts?: {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}): Promise<SynthFxEmscriptenModule>;
