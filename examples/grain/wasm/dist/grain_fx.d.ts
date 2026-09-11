export interface GrainFxEmscriptenModule {
  HEAPF32: Float32Array;
  UTF8ToString(ptr: number): string;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _grainfx_create(sampleRate: number): number;
  _grainfx_destroy(handle: number): void;
  _grainfx_set_param(handle: number, address: number, value: number): void;
  _grainfx_set_host_bpm(handle: number, bpm: number): void;
  _grainfx_process(
    handle: number,
    inL: number,
    inR: number,
    outL: number,
    outR: number,
    frames: number,
  ): void;
  _grainfx_load_loop(handle: number, dataL: number, dataR: number, count: number): void;
  _grainfx_release_loop(handle: number): void;
  _grainfx_note_on(handle: number, note: number, velocity: number): void;
  _grainfx_note_off(handle: number, note: number): void;
  _grainfx_cc(handle: number, cc: number, on: number): void;
  _grainfx_last_error(): number;
}

export default function createGrainFxModule(opts?: {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}): Promise<GrainFxEmscriptenModule>;
