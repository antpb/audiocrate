/**
 * Audiocrate's own voice worklet: the ASL interpreter and nothing else.
 *
 * It registers core kernels only (today: IR convolution). Crate core does
 * not ship a neural amp, a granular engine, or anyone's proprietary DSP.
 * A host that needs those writes its own entry beside this one:
 *
 * ```ts
 * import { defineCrateVoiceProcessor } from 'audiocrate';
 * import { myKernelFactory } from './my-kernel';
 *
 * defineCrateVoiceProcessor('crate-voice-processor', { amp: myKernelFactory });
 * ```
 *
 * (`audiocrate-amp` and its siblings are companion packages that are not
 * published yet, so the example uses a local factory rather than pointing at
 * something you cannot install.)
 *
 * and then points its bundler's worklet entry at that file. Keeping the
 * processor *name* the same means `WebAudioRenderer` needs no change; passing
 * a different name is supported too, for a host running two worklet builds.
 *
 * The interpreter itself is imported from `asl/compile.ts`, the same module
 * vitest exercises, so there is no second hand-written copy of the DSP to
 * drift out of sync. "Fused into one unit" here means one processor per
 * voice, not one AudioNode per ASL primitive.
 */
import { defineCrateVoiceProcessor } from './defineVoiceProcessor';

defineCrateVoiceProcessor('crate-voice-processor');
