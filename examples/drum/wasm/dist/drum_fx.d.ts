/** Hand-written types for the emscripten output of build_drum_fx.sh. */
export interface DrumFxModule {
  HEAPF32: Float32Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _drumfx_create(sampleRate: number, maxFrames: number): number;
  _drumfx_destroy(handle: number): void;
  _drumfx_set_param(handle: number, address: number, value: number): void;
  _drumfx_load_pad(handle: number, pad: number, left: number, right: number, frames: number, rate: number): void;
  _drumfx_note_on(handle: number, note: number, velocity: number): void;
  _drumfx_set_context(handle: number, valid: number, beat: number, tempo: number): void;
  _drumfx_buffer(handle: number, which: number): number;
  _drumfx_process(handle: number, frames: number): void;
}
export default function createDrumFxModule(opts?: {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}): Promise<DrumFxModule>;
