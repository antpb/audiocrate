/** Synth kernel. WASM engine is in SynthEngine.ts. */
export interface SynthProcessor {
  applyParams(params: Record<string, number>): void;
  setHostBpm(bpm: number): void;
  process(outputL: Float32Array, outputR: Float32Array | null): void;
  noteOn(note: number, velocity: number): void;
  noteOff(note: number): void;
  allNotesOff(): void;
  setIRSlot(slot: number, samples: Float32Array): void;
  clearIRSlot(slot: number): void;
  dispose(): void;
}
