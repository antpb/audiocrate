import { AU_TYPE_INSTRUMENT, type AssetRequest, type AudioMaterialPlugin } from './crate';
import { NUM_PADS } from './drumParams';
import { createDrumMaterial } from './drumMaterial';
import { drumPadKey } from './drumPads';
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
