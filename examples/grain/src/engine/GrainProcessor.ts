/**
 * Full grain kernel (capture, grains, delay, Costello, resonator, wash).
 * compile.ts only knows this interface; the WASM engine lives in GrainEngine.ts.
 */
export interface GrainProcessor {
  applyParams(params: Record<string, number>): void;
  setHostBpm(bpm: number): void;
  process(
    inputL: Float32Array,
    inputR: Float32Array | null,
    outputL: Float32Array,
    outputR: Float32Array | null,
  ): void;
  loadLoop(samplesL: Float32Array, samplesR?: Float32Array | null): void;
  releaseLoop(): void;
  noteOn(note: number, velocity: number): void;
  noteOff(note: number): void;
  controlChange?(cc: number, on: boolean): void;
  dispose(): void;
}
