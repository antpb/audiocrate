/**
 * Same voice processor as crate's, with the example kernels compiled in.
 *
 * An AudioWorklet cannot import code at runtime, so the kernels have to be
 * in this bundle. Same processor name as crate's default, so
 * `new WebAudioRenderer(ctx, { workletUrl })` needs nothing else.
 */
import { defineCrateVoiceProcessor } from '../../../src/renderers/worklet/defineVoiceProcessor';
import { ampKernelFactory } from '../../amp/src/kernel';
import { grainKernelFactory } from '../../grain/src/kernel';
import { synthKernelFactory } from '../../synth/src/kernel';
import { spaceReverbKernelFactory } from '../../space-reverb/src/kernel';
import { AMP_KERNEL_SLOT } from '../../amp/src/kernelSlot';
import { GRAIN_KERNEL_SLOT } from '../../grain/src/kernelSlot';
import { SYNTH_KERNEL_SLOT } from '../../synth/src/kernelSlot';
import { SPACE_REVERB_KERNEL_SLOT } from '../../space-reverb/src/kernelSlot';

defineCrateVoiceProcessor('crate-voice-processor', {
  [AMP_KERNEL_SLOT]: ampKernelFactory,
  [GRAIN_KERNEL_SLOT]: grainKernelFactory,
  [SYNTH_KERNEL_SLOT]: synthKernelFactory,
  [SPACE_REVERB_KERNEL_SLOT]: spaceReverbKernelFactory,
});
