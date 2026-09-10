import namWasmUrl from '../../../crate-amp/wasm/dist/nam.wasm?url';
import ampFxWasmUrl from '../../../crate-amp/wasm/dist/amp_fx.wasm?url';
import grainFxWasmUrl from '../../../crate-grain/wasm/dist/grain_fx.wasm?url';
import synthFxWasmUrl from '../../../crate-synth/wasm/dist/synth_fx.wasm?url';
import spaceReverbWasmUrl from '../../../crate-space-reverb/wasm/dist/space_reverb.wasm?url';
import { fetchKernelBinary, type KernelBinaryMap } from '../../src/index';

const AMP_KERNEL_SLOT = 'homecrate.amp';
const GRAIN_KERNEL_SLOT = 'homecrate.grain';
const SYNTH_KERNEL_SLOT = 'homecrate.synth';
const SPACE_REVERB_KERNEL_SLOT = 'homecrate.space-reverb';

let cache: KernelBinaryMap | null = null;

async function loadIfPresent(url: string): Promise<ArrayBuffer | undefined> {
  if (!url) return undefined;
  return fetchKernelBinary(url);
}

export async function patcherKernelBinaries(): Promise<KernelBinaryMap> {
  if (cache) return cache;
  const [nam, ampFx, grain, synth, spaceReverb] = await Promise.all([
    loadIfPresent(namWasmUrl),
    loadIfPresent(ampFxWasmUrl),
    loadIfPresent(grainFxWasmUrl),
    loadIfPresent(synthFxWasmUrl),
    loadIfPresent(spaceReverbWasmUrl),
  ]);
  cache = {
    ...(ampFx ? { [AMP_KERNEL_SLOT]: ampFx } : {}),
    ...(nam ? { nam } : {}),
    ...(grain ? { [GRAIN_KERNEL_SLOT]: grain } : {}),
    ...(synth ? { [SYNTH_KERNEL_SLOT]: synth } : {}),
    ...(spaceReverb ? { [SPACE_REVERB_KERNEL_SLOT]: spaceReverb } : {}),
  };
  return cache;
}
