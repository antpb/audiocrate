/** Hand-written types for the emscripten output of build_dyneq.sh. */
export interface DyneqModule {
  HEAPF32: Float32Array;
  _dyneq_create(sampleRate: number, maxFrames: number): number;
  _dyneq_destroy(handle: number): void;
  _dyneq_set_param(handle: number, address: number, value: number): void;
  _dyneq_buffer(handle: number, which: number): number;
  _dyneq_process(handle: number, frames: number, stereoIn: number, bus: number): void;
  _dyneq_follower(handle: number): number;
  _dyneq_gain_reduction(handle: number): number;
}
export default function createDyneqModule(opts?: {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}): Promise<DyneqModule>;
