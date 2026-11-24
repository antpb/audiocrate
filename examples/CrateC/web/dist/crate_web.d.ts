/** Hand-written types for the emscripten output of web/build.sh. */
export interface CrateWebModule {
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  UTF8ToString(ptr: number): string;
  stringToUTF8(text: string, ptr: number, maxBytes: number): void;
  lengthBytesUTF8(text: string): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _crateweb_create(graph: number, length: number, instrument: number, polyphony: number, sampleRate: number, maxFrames: number, seed: number): number;
  _crateweb_set_tables(tables: number, count: number): void;
  _crateweb_destroy(handle: number): void;
  _crateweb_last_error(): number;
  _crateweb_param_count(handle: number): number;
  _crateweb_param_name(handle: number, index: number): number;
  _crateweb_set_param(handle: number, index: number, value: number): void;
  _crateweb_note_on(handle: number, note: number, velocity: number): void;
  _crateweb_note_off(handle: number, note: number): void;
  _crateweb_all_notes_off(handle: number): void;
  _crateweb_active_voices(handle: number): number;
  _crateweb_set_transport(handle: number, beats: number, bpm: number, playing: number, beatsPerBar: number, beatUnit: number): void;
  _crateweb_buffer(handle: number, which: number): number;
  _crateweb_process(handle: number, frames: number, stereoIn: number): void;
}

export default function createCrateWebModule(opts?: {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}): Promise<CrateWebModule>;
