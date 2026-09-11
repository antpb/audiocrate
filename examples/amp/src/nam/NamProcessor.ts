/**
 * NAM implementor used by `neural.nam`. The WASM engine is in NamEngine.ts
 * so the interpreter does not import emscripten.
 */
export interface NamProcessor {
  readonly architecture: string;
  readonly a2Fast: boolean;
  readonly a2Channels: number;
  processSample(x: number): number;
  processBlock(input: Float32Array, output: Float32Array): void;
  dispose(): void;
}
