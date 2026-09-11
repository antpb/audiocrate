export interface SpaceReverbEmscriptenModule {
  HEAPF32: Float32Array;
  UTF8ToString(ptr: number): string;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _spacereverb_create(sampleRate: number): number;
  _spacereverb_destroy(handle: number): void;
  _spacereverb_set_param(handle: number, address: number, value: number): void;
  _spacereverb_process(handle: number, bufPtr: number, frames: number): void;
  _spacereverb_last_error(): number;
}

export default function createSpaceReverbModule(opts?: {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}): Promise<SpaceReverbEmscriptenModule>;
