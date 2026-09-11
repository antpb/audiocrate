import { AU_TYPE_INSTRUMENT, type AssetRequest, type AudioMaterialPlugin } from './crate';
import { createSynthMaterial } from './synthMaterial';
import { SYNTH_IR_SLOT_COUNT, synthIrSlotKey, synthIrSlots } from './assets';
import { SYNTH_KERNEL_SLOT } from './kernelSlot';
import {
  HOMECRATE_SYNTH_MANUFACTURER,
  HOMECRATE_SYNTH_SUBTYPE,
  applySynthPreset,
  decodeSynthPreset,
  type DecodedSynthPreset,
} from './synthPreset';
import type { SynthKernelMessage, SynthKernelPayload } from './kernel';

/** Presets can leave these at zero. A loaded instrument with no level is silent. */
function liftSilentLevels(material: ReturnType<typeof createSynthMaterial>): void {
  const snap = material.snapshotParams();
  if ((snap.masterGain ?? 0) <= 0) material.setParam('masterGain', 0.8);
  if ((snap.oscMasterLevel ?? 0) <= 0) material.setParam('oscMasterLevel', 0.8);
  if ((snap.oscALevel ?? 0) <= 0 && (snap.oscBLevel ?? 0) <= 0) {
    material.setParam('oscALevel', 1);
    material.setParam('oscBLevel', 1);
  }
}

export const synthPlugin: AudioMaterialPlugin<DecodedSynthPreset> = {
  kind: 'synth',
  label: 'Synth',
  role: 'instrument',

  create: createSynthMaterial,

  host: {
    componentType: AU_TYPE_INSTRUMENT,
    componentSubType: HOMECRATE_SYNTH_SUBTYPE,
    componentManufacturer: HOMECRATE_SYNTH_MANUFACTURER,
  },

  decodePreset: decodeSynthPreset,
  emptyPreset: () => ({ params: {}, irSlotFilenames: [], raw: {} }),
  applyPreset: applySynthPreset,

  assetRequests(preset): AssetRequest[] {
    const requests: AssetRequest[] = [];
    for (let slot = 0; slot < SYNTH_IR_SLOT_COUNT; slot++) {
      const filename = preset.irSlotFilenames[slot];
      if (!filename) continue;
      requests.push({ key: synthIrSlotKey(slot), library: 'IR', filename, decode: 'audio' });
    }
    return requests;
  },

  async bindLiveVoice(voice, material, binaries) {
    liftSilentLevels(material);
    voice.noteOn(material.snapshotParams());
    const wasm = binaries[SYNTH_KERNEL_SLOT] ?? binaries.synthFx;
    if (!wasm) return;
    await voice.loadKernel(SYNTH_KERNEL_SLOT, { wasm } satisfies SynthKernelPayload);
    synthIrSlots(material).forEach((asset, slot) => {
      if (!asset) return;
      voice.sendKernel(SYNTH_KERNEL_SLOT, {
        type: 'setIRSlot',
        slot,
        samples: asset.samples,
      } satisfies SynthKernelMessage);
    });
  },
};
