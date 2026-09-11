export interface AmpFxEmscriptenModule {
  HEAPF32: Float32Array;
  UTF8ToString(ptr: number): string;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _ampfx_create(sampleRate: number): number;
  _ampfx_destroy(handle: number): void;
  _ampfx_set_param(handle: number, address: number, value: number): void;
  _ampfx_set_host_bpm(handle: number, bpm: number): void;
  _ampfx_set_ir(handle: number, dataPtr: number, count: number): void;
  _ampfx_clear_ir(handle: number): void;
  _ampfx_latency_samples(handle: number): number;
  _ampfx_process_pre(handle: number, bufPtr: number, frames: number): void;
  _ampfx_process_post(handle: number, bufPtr: number, frames: number): void;
  _ampfx_last_error(): number;
}

export default function createAmpFxModule(opts?: {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}): Promise<AmpFxEmscriptenModule>;
