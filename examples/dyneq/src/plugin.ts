/**
 * hc_dynEQ and hc_send as plugins.
 *
 * Both are kernels from end to end, like the grain: the material's graph is
 * the kernel (`kernel.source`), passthrough when the kernel is absent, so a
 * host without the worklet (an offline render) plays the track dry rather
 * than silent. Presets are the AU's fullState: `param_N` by address.
 */
import {
  AU_TYPE_EFFECT,
  AU_TYPE_MUSIC_EFFECT,
  AudioMaterial,
  decodeAddressedParams,
  decodePresetBlob,
  kernel,
  type AudioMaterialPlugin,
} from './crate';
import { dyneqParams, sendParams } from './params';
import { DYNEQ_KERNEL_SLOT, SEND_KERNEL_SLOT } from './kernelSlot';
import type { DyneqKernelPayload } from './kernel';

/** `dyeq`, hc_dynEQ's subtype (registered as `aufx` and as `aumf`). */
export const HOMECRATE_DYNEQ_SUBTYPE = 0x64796571;
/** `send`, hc_send's subtype. */
export const HOMECRATE_SEND_SUBTYPE = 0x73656e64;
/** `NAMp`, the manufacturer both register under. */
export const HOMECRATE_DYNEQ_MANUFACTURER = 0x4e414d70;

export interface AddressedPreset {
  params: Record<string, number>;
}

function material(name: string, kind: string, params: typeof dyneqParams, slot: string): AudioMaterial {
  return new AudioMaterial({
    name,
    kind,
    params,
    automatable: Object.keys(params),
    graph: ({ input }) => kernel.source(slot, input!, { fallback: 'passthrough' }),
  });
}

export const createDyneqMaterial = () => material('dynEQ', 'dyneq', dyneqParams, DYNEQ_KERNEL_SLOT);
export const createSendMaterial = () => material('Send', 'send', sendParams, SEND_KERNEL_SLOT);

function addressed(params: typeof dyneqParams) {
  return {
    decodePreset: (blob: string): AddressedPreset => ({ params: decodeAddressedParams(decodePresetBlob(blob), params) }),
    emptyPreset: (): AddressedPreset => ({ params: {} }),
    applyPreset(m: AudioMaterial, preset: AddressedPreset) {
      for (const [name, value] of Object.entries(preset.params)) m.setParam(name, value);
    },
  };
}

export const dyneqPlugin: AudioMaterialPlugin<AddressedPreset> = {
  kind: 'dyneq',
  label: 'dynEQ',
  role: 'insert',
  create: createDyneqMaterial,
  host: {
    componentSubType: HOMECRATE_DYNEQ_SUBTYPE,
    componentManufacturer: HOMECRATE_DYNEQ_MANUFACTURER,
    componentTypes: [AU_TYPE_EFFECT, AU_TYPE_MUSIC_EFFECT],
  },
  ...addressed(dyneqParams),
  async bindLiveVoice(voice, _material, binaries) {
    const wasm = binaries[DYNEQ_KERNEL_SLOT];
    if (!wasm) {
      console.warn(`[homecrate] dynEQ kernel not loaded; playing dry (pass binaries['${DYNEQ_KERNEL_SLOT}'])`);
      return;
    }
    await voice.loadKernel(DYNEQ_KERNEL_SLOT, { wasm } satisfies DyneqKernelPayload);
  },
};

export const sendPlugin: AudioMaterialPlugin<AddressedPreset> = {
  kind: 'send',
  label: 'Send',
  role: 'insert',
  create: createSendMaterial,
  host: {
    componentSubType: HOMECRATE_SEND_SUBTYPE,
    componentManufacturer: HOMECRATE_DYNEQ_MANUFACTURER,
    componentTypes: [AU_TYPE_EFFECT, AU_TYPE_MUSIC_EFFECT],
  },
  ...addressed(sendParams),
  async bindLiveVoice(voice) {
    await voice.loadKernel(SEND_KERNEL_SLOT, {});
  },
};

/**
 * Tracks whose dynEQ and hc_send meet on the envelope bus, which exists only
 * inside one audio realm: if a scene has any hc_send, every track holding a
 * dynEQ or a send must play in the same one (live, not rendered ahead on a
 * worker of its own). Empty when there is no send, since a dynEQ with no
 * sender reads 0 wherever it runs.
 */
export function envelopeBusTracks<T extends { materials: { list: readonly { kind: string }[] } }>(tracks: readonly T[]): Set<T> {
  const holds = (t: T, kind: string) => t.materials.list.some((m) => m.kind === kind);
  if (!tracks.some((t) => holds(t, 'send'))) return new Set();
  return new Set(tracks.filter((t) => holds(t, 'send') || holds(t, 'dyneq')));
}
