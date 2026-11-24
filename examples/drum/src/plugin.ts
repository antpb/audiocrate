import { AU_TYPE_INSTRUMENT, AudioMaterial, kernel, type AssetRequest, type AudioAssetData, type AudioMaterialPlugin } from './crate';
import { NUM_PADS } from './drumParams';
import { createDrumMaterial } from './drumMaterial';
import { drumPadAsset, drumPadKey, setDrumPadAsset } from './drumPads';
import { DRUM_KERNEL_SLOT } from './kernelSlot';
import type { DrumKernelMessage, DrumKernelPayload } from './kernel';
import {
  HOMECRATE_DRUM_MANUFACTURER,
  HOMECRATE_DRUM_SUBTYPE,
  applyDrumPreset,
  decodeDrumPreset,
  type DecodedDrumPreset,
} from './drumPreset';

/**
 * The drum as a plugin.
 *
 * No `bindLiveVoice` and no kernel slot: the whole instrument is the graph,
 * so there is nothing to load into the worklet beyond the graph itself and
 * the pad buffers, which arrive as assets. It is the only one of the
 * homecrate examples that is pure ASL.
 */
export const drumPlugin: AudioMaterialPlugin<DecodedDrumPreset> = {
  kind: 'drum',
  label: 'Drum',
  role: 'instrument',

  create: () => createDrumMaterial(),

  host: {
    componentType: AU_TYPE_INSTRUMENT,
    componentSubType: HOMECRATE_DRUM_SUBTYPE,
    componentManufacturer: HOMECRATE_DRUM_MANUFACTURER,
  },

  decodePreset: decodeDrumPreset,
  emptyPreset: () => ({ params: {}, padFilenames: [], raw: {} }),
  applyPreset: applyDrumPreset,

  // Live, the drum is its own engine: the VST3 port's DrumEngine in WASM
  // (kernel.ts), one voice taking MIDI. The ASL graph (sixteen 026S chains)
  // stays for offline renders and bakes; live it is more than an audio
  // thread has, and it has no stretch, choke or humanize.
  liveGraph: (material) =>
    new AudioMaterial({
      name: `${material.name} (engine)`,
      kind: material.kind,
      params: material.params,
      graph: () => kernel.source(DRUM_KERNEL_SLOT, undefined, { fallback: 'silence' }),
    }).graph,

  async bindLiveVoice(voice, material, binaries) {
    const wasm = binaries[DRUM_KERNEL_SLOT];
    if (!wasm) {
      console.warn(`[homecrate] drum kernel not loaded; the drum is silent live (pass binaries['${DRUM_KERNEL_SLOT}'])`);
      return;
    }
    await voice.loadKernel(DRUM_KERNEL_SLOT, { wasm } satisfies DrumKernelPayload);
    for (let pad = 0; pad < NUM_PADS; pad++) {
      const asset = drumPadAsset(material, pad);
      if (!asset || asset.samples.length < 2) continue;
      voice.sendKernel(DRUM_KERNEL_SLOT, {
        type: 'loadPad',
        pad,
        left: asset.samples,
        right: asset.samplesR ?? null,
        sampleRate: asset.sampleRate,
      } satisfies DrumKernelMessage);
    }
  },

  // A pad's file goes into the playhead the graph reads, not only onto the
  // material: stored with plain setAsset, a loaded kit played silence.
  applyAsset(material, key, value) {
    const pad = Number(/^drum\.pad\.(\d+)$/.exec(key)?.[1] ?? NaN);
    if (Number.isInteger(pad) && pad >= 0 && pad < NUM_PADS) setDrumPadAsset(material, pad, value as AudioAssetData);
    else material.setAsset(key, value);
  },

  assetRequests(preset): AssetRequest[] {
    const requests: AssetRequest[] = [];
    for (let pad = 0; pad < NUM_PADS; pad++) {
      const filename = preset.padFilenames[pad];
      if (!filename) continue;
      requests.push({
        key: drumPadKey(pad),
        library: 'samples',
        fallbackLibraries: ['Samples'],
        filename,
        decode: 'audio',
      });
    }
    return requests;
  },
};
