import { OfflineRenderer, type AudioMaterial } from './crate';
import { spaceReverbKernelFactory } from './kernel';
import { SPACE_REVERB_KERNEL_SLOT } from './kernelSlot';

export interface BakeSpaceReverbOptions {
  wasmBinary?: ArrayBuffer | Uint8Array;
}

/**
 * One channel through Costello. A missing binary is a dry copy: the seam
 * is a passthrough.
 */
export async function processSpaceReverbMaterial(
  material: AudioMaterial,
  channels: readonly Float32Array[],
  sampleRate: number,
  options: BakeSpaceReverbOptions = {},
): Promise<Float32Array[]> {
  if (!options.wasmBinary) {
    return channels.map((channel) => channel.slice());
  }

  const out: Float32Array[] = [];
  for (const channel of channels) {
    const kernel = await spaceReverbKernelFactory(sampleRate, { wasm: options.wasmBinary });
    try {
      const rendered = OfflineRenderer.render(material.graph, {
        duration: channel.length / sampleRate,
        sampleRate,
        inputSignal: channel,
        params: material.snapshotParams(),
        kernels: { [SPACE_REVERB_KERNEL_SLOT]: kernel },
      });
      out.push(rendered.samples);
    } finally {
      kernel.dispose?.();
    }
  }
  return out;
}
