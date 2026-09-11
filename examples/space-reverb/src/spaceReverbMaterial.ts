import { AudioMaterial, param, kernel, type AudioMaterialGraphContext, type RangeParamDescriptor } from './crate';
import { SPACE_REVERB_KERNEL_SLOT } from './kernelSlot';

/**
 * Costello room params, same names, ranges, and units the amp exposes.
 * Addresses are this plugin's own tree (0..5), not the amp's 8/9/10...
 * `reverbPreAmp` is omitted: there is no amp here.
 */

export function createSpaceReverbMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'Space Reverb',
    kind: 'spacereverb',
    params: spaceReverbParams,
    automatable: Object.keys(spaceReverbParams),
    graph: spaceReverbGraph,
  });
}

export const spaceReverbParams: Record<string, RangeParamDescriptor> = {
  reverbDecay: param.range(0, 1, { default: 0.5, address: 0 }),
  reverbBlend: param.range(0, 1, { default: 0.28, address: 1 }),
  reverbSize: param.range(0.5, 2, { default: 1, address: 2 }),
  reverbPreDelay: param.range(0, 100, { default: 0, unit: 'ms', address: 3 }),
  reverbTone: param.range(0, 1, { default: 0.7, address: 4 }),
  reverbGate: param.range(0, 1, { default: 0, unit: 'bool', address: 5 }),
};

function spaceReverbGraph({ input }: AudioMaterialGraphContext) {
  return kernel.seam(SPACE_REVERB_KERNEL_SLOT, input);
}

export const spaceReverbMaterial = createSpaceReverbMaterial();
