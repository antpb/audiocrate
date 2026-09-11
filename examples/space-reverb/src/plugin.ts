import { type AudioMaterialPlugin, type KernelBinaryMap } from './crate';
import { createSpaceReverbMaterial } from './spaceReverbMaterial';
import { SPACE_REVERB_KERNEL_SLOT } from './kernelSlot';
import { processSpaceReverbMaterial } from './bakeSpaceReverb';
import type { SpaceReverbKernelPayload } from './kernel';

export const spaceReverbPlugin: AudioMaterialPlugin = {
  kind: 'spacereverb',
  label: 'Space Reverb',
  role: 'insert',

  create: createSpaceReverbMaterial,

  async bindLiveVoice(voice, _material, binaries: KernelBinaryMap) {
    const wasm = binaries[SPACE_REVERB_KERNEL_SLOT] ?? binaries.spaceReverb;
    if (!wasm) return;
    await voice.loadKernel(SPACE_REVERB_KERNEL_SLOT, { wasm } satisfies SpaceReverbKernelPayload);
  },

  async bake(material, channels, sampleRate, binaries) {
    return processSpaceReverbMaterial(material, channels, sampleRate, {
      wasmBinary: binaries[SPACE_REVERB_KERNEL_SLOT] ?? binaries.spaceReverb,
    });
  },
};
