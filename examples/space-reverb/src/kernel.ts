/**
 * Costello as a crate seam kernel. One block in, one block out.
 */
import { createSpaceReverb } from './engine/SpaceReverbEngine';
import type { SpaceReverbProcessor } from './engine/SpaceReverbProcessor';
import type { KernelFactory, KernelProcessor } from './crate';

export interface SpaceReverbKernelPayload {
  wasm?: ArrayBuffer | Uint8Array;
}

class SpaceReverbKernel implements KernelProcessor {
  private readonly one = new Float32Array(1);

  constructor(private readonly engine: SpaceReverbProcessor) {}

  applyParams(params: Record<string, number>): void {
    this.engine.applyParams(params);
  }

  processSeam(input: Float32Array, output: Float32Array): void {
    if (input !== output) output.set(input);
    this.engine.process(output);
  }

  processSeamSample(x: number): number {
    this.one[0] = x;
    this.engine.process(this.one);
    return this.one[0]!;
  }

  describe(): unknown {
    return { engine: 'costello' };
  }

  dispose(): void {
    this.engine.dispose();
  }
}

export const spaceReverbKernelFactory: KernelFactory = async (sampleRate, payload) => {
  const { wasm } = (payload ?? {}) as SpaceReverbKernelPayload;
  if (!wasm) throw new Error('space reverb kernel needs space_reverb.wasm bytes in its payload');
  return new SpaceReverbKernel(await createSpaceReverb(sampleRate, { wasmBinary: wasm }));
};
