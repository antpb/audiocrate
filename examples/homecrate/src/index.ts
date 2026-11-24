/**
 * Registers amp, drum, grain, synth, and space-reverb.
 *
 * Two halves that have to agree:
 *
 *  1. This file (main thread): slot mapping, assets, latency, live bind, bake.
 *  2. `worklet/homecrate-voice-processor.ts`: the kernels compiled into the
 *     audio-thread bundle. An AudioWorklet cannot import code at runtime.
 *
 * Register without the matching worklet and `loadKernel` rejects with
 * "no kernel registered for slot ...".
 */
import {
  audioMaterialRegistry,
  fetchKernelBinary,
  registerCoreMaterials,
  type AudioMaterialRegistry,
  type KernelBinaryMap,
} from '../../../src/index';
import { ampPlugin } from '../../amp/src/index';
import { drumPlugin } from '../../drum/src/index';
import { grainPlugin } from '../../grain/src/index';
import { synthPlugin } from '../../synth/src/index';
import { spaceReverbPlugin } from '../../space-reverb/src/index';
import { crateEffectPlugin, crateInstrumentPlugin, CRATE_KERNEL_SLOT } from '../../CrateC/web/src/plugin';
import { dyneqPlugin, sendPlugin, envelopeBusTracks, DYNEQ_KERNEL_SLOT } from '../../dyneq/src/index';

export { ampPlugin, drumPlugin, grainPlugin, synthPlugin, spaceReverbPlugin, crateInstrumentPlugin, crateEffectPlugin };
export { CRATE_KERNEL_SLOT, dyneqPlugin, sendPlugin, envelopeBusTracks, DYNEQ_KERNEL_SLOT };
export { AMP_KERNEL_SLOT } from '../../amp/src/kernelSlot';
export { GRAIN_KERNEL_SLOT } from '../../grain/src/kernelSlot';
export { SYNTH_KERNEL_SLOT } from '../../synth/src/kernelSlot';
export { SPACE_REVERB_KERNEL_SLOT } from '../../space-reverb/src/kernelSlot';

/** Drum has no kernel slot: it is pure ASL, so the worklet needs nothing added for it. */
export const homecrateMaterials = [
  ampPlugin,
  drumPlugin,
  grainPlugin,
  synthPlugin,
  spaceReverbPlugin,
  // Core registers the crate AU too, as plain ASL; these replace it with the
  // same plugins played live by CrateC.
  crateInstrumentPlugin,
  crateEffectPlugin,
  dyneqPlugin,
  sendPlugin,
] as const;

/** Registers the set into a registry (the shared one by default). Idempotent. */
export function registerHomecrateMaterials(registry: AudioMaterialRegistry = audioMaterialRegistry): AudioMaterialRegistry {
  registerCoreMaterials(registry);
  registry.registerAll(homecrateMaterials);
  return registry;
}

/**
 * The WASM each kernel slot loads, by file name. Published next to the
 * worklet at `audiocrate/homecrate/wasm/<file>`; the editor imports the same
 * files from each example's `wasm/dist`.
 */
export const HOMECRATE_KERNEL_FILES: Readonly<Record<string, string>> = {
  'homecrate.amp': 'amp_fx.wasm',
  nam: 'nam.wasm',
  'homecrate.grain': 'grain_fx.wasm',
  'homecrate.synth': 'synth_fx.wasm',
  'homecrate.space-reverb': 'space_reverb.wasm',
  [CRATE_KERNEL_SLOT]: 'crate_web.wasm',
  [DYNEQ_KERNEL_SLOT]: 'dyneq.wasm',
  'homecrate.drum': 'drum_fx.wasm',
};

/** Kernel slots each plugin kind loads. */
const KERNEL_SLOTS_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  amp: ['homecrate.amp', 'nam'],
  grain: ['homecrate.grain'],
  synth: ['homecrate.synth'],
  spacereverb: ['homecrate.space-reverb'],
  'homecrate.crate': [CRATE_KERNEL_SLOT],
  'homecrate.crate-fx': [CRATE_KERNEL_SLOT],
  dyneq: [DYNEQ_KERNEL_SLOT],
  drum: ['homecrate.drum'],
};

/**
 * The kernel slots a scene's materials need, for
 * `loadHomecrateKernelBinaries(base, homecrateKernelSlots(scene))`.
 */
export function homecrateKernelSlots(scene: {
  tracks: readonly { instrument?: { kind: string } | null; materials: { list: readonly { kind: string }[] } }[];
  master: { materials: { list: readonly { kind: string }[] } };
}): string[] {
  const slots = new Set<string>();
  const add = (material: { kind: string } | null | undefined) => {
    for (const slot of KERNEL_SLOTS_BY_KIND[material?.kind ?? ''] ?? []) slots.add(slot);
  };
  scene.master.materials.list.forEach(add);
  for (const track of scene.tracks) {
    add(track.instrument);
    track.materials.list.forEach(add);
  }
  return [...slots];
}

/**
 * Fetches the kernels for `scene.prepareLiveVoices(renderer, binaries)`.
 * `baseUrl` is where the wasm files are served (a trailing slash is added).
 * `only` limits it to some slots; a file that fails to load is left out, and
 * its plugin then plays its ASL graph or stays silent, as without a kernel.
 */
export async function loadHomecrateKernelBinaries(
  baseUrl: string,
  only?: readonly string[],
): Promise<KernelBinaryMap> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const slots = Object.keys(HOMECRATE_KERNEL_FILES).filter((slot) => !only || only.includes(slot));
  const loaded = await Promise.all(
    slots.map(async (slot) => {
      try {
        return [slot, await fetchKernelBinary(`${base}${HOMECRATE_KERNEL_FILES[slot]}`)] as const;
      } catch (error) {
        console.warn(`[homecrate] kernel ${slot} did not load`, error);
        return null;
      }
    }),
  );
  return Object.fromEntries(loaded.filter((entry) => entry !== null));
}
