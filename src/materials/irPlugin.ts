import type { AssetRequest } from '../graph/assets';
import type { AudioMaterial } from '../graph/AudioMaterial';
import type { AudioMaterialPlugin } from '../registry/AudioMaterialPlugin';
import type { VoiceHandle } from '../renderers/WebAudioRenderer';
import { createIrMaterial, irAsset, irLatencySamples, IR_ASSET } from './ir';
import { IR_KERNEL_SLOT, type IrKernelMessage, type IrKernelPayload } from '../renderers/kernels/irKernel';
import { PartitionedConvolver, IR_PARTITION_SIZE } from '../dsp/convolver';

let livePartSize = IR_PARTITION_SIZE;

/** Live IR hop. Auto (0) stays 512. 64/128/256 cut cabinet delay at more CPU. */
export function setLiveIrPartitionSize(frames: number): void {
  livePartSize = frames >= 32 && (frames & (frames - 1)) === 0 ? frames : IR_PARTITION_SIZE;
}

/**
 * Standalone convolution. Space simulation is a general audio operation,
 * not an amp feature. The kernel is JS (no WASM) and ships in every crate
 * worklet. A hop-aligned process is causal, so this AudioMaterial reports no
 * extra mix delay. The amp cabinet still reports 512 from its WASM.
 */
export const irPlugin: AudioMaterialPlugin<{ filename?: string }> = {
  kind: 'ir',
  label: 'IR',
  role: 'insert',
  create: createIrMaterial,

  emptyPreset: () => ({}),

  assetRequests(preset): AssetRequest[] {
    if (!preset.filename) return [];
    return [{ key: IR_ASSET, library: 'IR', filename: preset.filename, decode: 'audio' }];
  },

  latencySamples: irLatencySamples,

  async bindLiveVoice(voice: VoiceHandle, material: AudioMaterial) {
    const ir = irAsset(material);
    const payload: IrKernelPayload = ir ? { samples: ir.samples, partSize: livePartSize } : {};
    await voice.loadKernel(IR_KERNEL_SLOT, payload);
    if (ir) {
      voice.sendKernel(IR_KERNEL_SLOT, {
        type: 'setIR',
        samples: ir.samples,
        partSize: livePartSize,
      } satisfies IrKernelMessage);
    }
  },

  async bake(material, channels) {
    const ir = irAsset(material);
    const mix = material.getParam('mix');
    const gain = material.getParam('gain');
    if (!ir) {
      return channels.map((ch) => {
        const out = new Float32Array(ch.length);
        for (let i = 0; i < ch.length; i++) out[i] = ch[i]! * gain;
        return out;
      });
    }
    return channels.map((ch) => {
      const conv = new PartitionedConvolver();
      conv.setup(ir.samples, IR_PARTITION_SIZE);
      const paddedLen = Math.ceil(Math.max(ch.length, 1) / IR_PARTITION_SIZE) * IR_PARTITION_SIZE;
      const padded = new Float32Array(paddedLen);
      padded.set(ch);
      const wetPadded = new Float32Array(paddedLen);
      conv.process(padded, wetPadded);
      const out = new Float32Array(ch.length);
      const dryGain = 1 - mix;
      for (let i = 0; i < ch.length; i++) {
        out[i] = (ch[i]! * dryGain + wetPadded[i]! * mix) * gain;
      }
      return out;
    });
  },
};
