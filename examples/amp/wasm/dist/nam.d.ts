export interface NamEmscriptenModule {
  HEAPF32: Float32Array;
  UTF8ToString(ptr: number): string;
  stringToUTF8(str: string, ptr: number, maxBytes: number): number;
  lengthBytesUTF8(str: string): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _nam_create(jsonPtr: number, sampleRate: number, maxFrames: number): number;
  _nam_destroy(handle: number): void;
  _nam_process(handle: number, inPtr: number, outPtr: number, frames: number): void;
  _nam_last_error(): number;
  _nam_has_loudness(handle: number): number;
  _nam_get_loudness(handle: number): number;
    _nam_has_input_level(handle: number): number;
    _nam_get_input_level(handle: number): number;
    _nam_architecture(handle: number): number;
    _nam_is_a2_fast(handle: number): number;
    _nam_a2_channels(handle: number): number;
}

export default function createNamModule(opts?: {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}): Promise<NamEmscriptenModule>;
