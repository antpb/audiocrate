/**
 * The crate AU's plugins, played live by the CrateC kernel.
 *
 * Core's `nativeCrateInstrumentPlugin` / `nativeCrateEffectPlugin` build a
 * crate patch as an ASL material, which renders anywhere (offline, in a bake,
 * with no worklet) through the JS interpreter. These are the same plugins
 * with a live path on top: a live voice compiles a `kernel.source` graph
 * and loads the patch into CrateC (`kernel.ts`), so the interpreter runs in
 * WASM, and an instrument's polyphony runs inside the module as one voice
 * taking MIDI, the way the synth does.
 *
 * Registered after core's, under the same kinds, so they replace them.
 */
import {
  AudioMaterial,
  CRATE_COMPILED_ASSET,
  CRATE_SEED_ASSET,
  kernel,
  nativeCrateEffectPlugin,
  nativeCrateInstrumentPlugin,
  type AudioMaterialPlugin,
  type CompiledMaterialDocument,
  type NativeCratePreset,
} from '../../../../src/index';
import { CRATE_KERNEL_SLOT } from './kernelSlot';
import type { CrateKernelPayload } from './kernel';

export { CRATE_KERNEL_SLOT };

function liveGraph(material: AudioMaterial, instrument: boolean) {
  // Same params as the material, so the kernel receives every value by name
  // each block; the graph itself is just the kernel.
  return new AudioMaterial({
    name: `${material.name} (CrateC)`,
    kind: material.kind,
    params: material.params,
    graph: (ctx) =>
      instrument
        ? kernel.source(CRATE_KERNEL_SLOT, undefined, { fallback: 'silence' })
        : kernel.source(CRATE_KERNEL_SLOT, ctx.input!, { fallback: 'passthrough' }),
  }).graph;
}

function withKernel(base: AudioMaterialPlugin<NativeCratePreset>, instrument: boolean): AudioMaterialPlugin<NativeCratePreset> {
  return {
    ...base,
    liveGraph(material) {
      // A crate with no compiled graph (an empty slot) keeps its own: silence
      // or a wire, and nothing to load.
      return material.getAsset<CompiledMaterialDocument>(CRATE_COMPILED_ASSET) ? liveGraph(material, instrument) : material.graph;
    },
    async bindLiveVoice(voice, material, binaries) {
      const compiled = material.getAsset<CompiledMaterialDocument>(CRATE_COMPILED_ASSET);
      const wasm = binaries[CRATE_KERNEL_SLOT];
      if (!compiled) return;
      if (!wasm) {
        console.warn(`[homecrate] crate kernel not loaded; "${material.name}" is silent live (pass binaries['${CRATE_KERNEL_SLOT}'])`);
        return;
      }
      await voice.loadKernel(CRATE_KERNEL_SLOT, {
        wasm,
        graph: JSON.stringify(compiled.graph),
        instrument,
        polyphony: material.polyphony,
        seed: material.getAsset<number>(CRATE_SEED_ASSET) ?? 0,
      } satisfies CrateKernelPayload);
    },
  };
}

export const crateInstrumentPlugin = withKernel(nativeCrateInstrumentPlugin, true);
export const crateEffectPlugin = withKernel(nativeCrateEffectPlugin, false);
