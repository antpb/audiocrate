/**
 * Grain as a `source` kernel. Capture, grains, delay, Costello, resonator,
 * and wash are one engine; there is no per-sample ASL around it.
 */
import { createGrainFx } from './engine/GrainEngine';
import type { GrainProcessor } from './engine/GrainProcessor';
import type { KernelFactory, KernelProcessor } from './crate';

export interface GrainKernelPayload {
  /** `grain_fx.wasm` bytes. */
  wasm?: ArrayBuffer;
}

export type GrainKernelMessage =
  | { type: 'loadLoop'; samplesL: Float32Array; samplesR?: Float32Array | null }
  | { type: 'releaseLoop' };

class GrainKernel implements KernelProcessor {
  constructor(private readonly engine: GrainProcessor) {}

  applyParams(params: Record<string, number>): void {
    this.engine.applyParams(params);
  }

  processSource(
    inputL: Float32Array,
    inputR: Float32Array | null,
    outputL: Float32Array,
    outputR: Float32Array | null,
  ): void {
    this.engine.process(inputL, inputR, outputL, outputR);
  }

  noteOn(note: number, velocity: number): void {
    this.engine.noteOn(note, velocity);
  }

  noteOff(note: number): void {
    this.engine.noteOff(note);
  }

  controlChange(cc: number, value: number): void {
    // The grain engine treats CC as switches, hence the 64 threshold rather
    // than a continuous value: this mirrors the native plugin's own mapping.
    this.engine.controlChange?.(cc, value >= 64);
  }

  setHostBpm(bpm: number): void {
    this.engine.setHostBpm(bpm);
  }

  onMessage(message: unknown): unknown {
    const msg = message as GrainKernelMessage;
    if (msg?.type === 'loadLoop') this.engine.loadLoop(msg.samplesL, msg.samplesR ?? null);
    else if (msg?.type === 'releaseLoop') this.engine.releaseLoop();
    return undefined;
  }

  dispose(): void {
    this.engine.dispose();
  }
}

export const grainKernelFactory: KernelFactory = async (sampleRate, payload) => {
  const { wasm } = (payload ?? {}) as GrainKernelPayload;
  if (!wasm) throw new Error('grain kernel needs grain_fx.wasm bytes in its payload');
  return new GrainKernel(await createGrainFx(sampleRate, { wasmBinary: wasm }));
};
