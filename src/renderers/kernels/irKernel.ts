import { IR_PARTITION_SIZE, PartitionedConvolver } from '../../dsp/convolver';
import type { KernelFactory, KernelProcessor } from '../kernel';
import type { AudioAssetData } from '../../graph/assets';

export const IR_KERNEL_SLOT = 'ir';

export type IrKernelMessage =
  | { type: 'setIR'; samples: ArrayLike<number>; partSize?: number }
  | { type: 'clearIR' };

export function createIrKernel(): KernelProcessor {
  const conv = new PartitionedConvolver();
  return {
    processSeam(input, output) {
      conv.process(input, output);
    },
    processSeamSample(input) {
      return conv.processSample(input);
    },
    onMessage(message: unknown) {
      const msg = message as IrKernelMessage;
      if (msg?.type === 'clearIR') {
        conv.setup(new Float32Array(0));
        return { latencySamples: 0 };
      }
      if (msg?.type === 'setIR') {
        conv.setup(msg.samples, msg.partSize ?? IR_PARTITION_SIZE);
        return { latencySamples: conv.latencySamples };
      }
      return undefined;
    },
    latencySamples() {
      return conv.latencySamples;
    },
    describe() {
      return { ready: conv.isReady, latencySamples: conv.latencySamples };
    },
  };
}

export type IrKernelPayload = { samples?: ArrayLike<number>; partSize?: number };

export const irKernelFactory: KernelFactory = (_sampleRate, payload) => {
  const kernel = createIrKernel();
  const data = payload as IrKernelPayload | undefined;
  if (data?.samples && data.samples.length > 0) {
    kernel.onMessage?.({ type: 'setIR', samples: data.samples, partSize: data.partSize });
  }
  return kernel;
};

export function irSamplesFromAsset(asset: AudioAssetData | undefined): Float32Array | undefined {
  return asset?.samples;
}
