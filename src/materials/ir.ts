import { AudioMaterial } from '../graph/AudioMaterial';
import { param } from '../graph/param';
import { kernel, mix, uniform } from '../asl/builders';
import type { AudioAssetData } from '../graph/assets';
import { IR_KERNEL_SLOT } from '../renderers/kernels/irKernel';

export const IR_ASSET = 'ir';
export const IR_ASSET_REF = 'ir.ref';

export function createIrMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'IR',
    kind: 'ir',
    params: {
      mix: param.range(0, 1, { default: 1 }),
      gain: param.range(0, 4, { default: 1 }),
    },
    automatable: ['mix', 'gain'],
    graph: ({ input, params }) => {
      const wet = kernel.seam(IR_KERNEL_SLOT, input).mul(params.mix);
      const dry = input.mul(uniform(1).add(params.mix.mul(-1)));
      return mix(dry, wet).mul(params.gain);
    },
  });
}

export const irMaterial = createIrMaterial();

export function setIrAsset(material: AudioMaterial, asset: AudioAssetData): void {
  material.setAsset(IR_ASSET, asset);
  material.setAsset(IR_ASSET_REF, asset.filename);
}

export function irAsset(material: AudioMaterial): AudioAssetData | undefined {
  return material.getAsset<AudioAssetData>(IR_ASSET);
}

export function irLatencySamples(_material: AudioMaterial): number {
  return 0;
}
