export interface SpaceReverbProcessor {
  applyParams(params: Record<string, number>): void;
  process(buffer: Float32Array): void;
  dispose(): void;
}
