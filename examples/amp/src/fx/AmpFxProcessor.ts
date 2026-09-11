/**
 * Post/pre-NAM amp FX (Costello, delay, IR). compile.ts only knows this
 * interface; the WASM engine lives in AmpFxEngine.ts.
 */
export interface AmpFxProcessor {
  applyParams(params: Record<string, number>): void;
  setHostBpm(bpm: number): void;
  setIR(samples: Float32Array): void;
  clearIR(): void;
  latencySamples(): number;
  processPre(buffer: Float32Array): void;
  processPost(buffer: Float32Array): void;
  dispose(): void;
}
