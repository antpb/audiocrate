import { AU_TYPE_EFFECT, type AssetRequest, type AudioMaterialPlugin } from './crate';
import { createGrainMaterial } from './grainMaterial';
import { GRAIN_ASSET, grainLoopAsset } from './assets';
import { GRAIN_KERNEL_SLOT } from './kernelSlot';
import {
  HOMECRATE_GRAIN_MANUFACTURER,
  HOMECRATE_GRAIN_SUBTYPE,
  applyGrainPreset,
  decodeGrainPreset,
  type DecodedGrainPreset,
} from './grainPreset';
import type { GrainKernelMessage, GrainKernelPayload } from './kernel';

export const grainPlugin: AudioMaterialPlugin<DecodedGrainPreset> = {
  kind: 'grain',
  label: 'Grain',
  role: 'insert',

  create: createGrainMaterial,

  host: {
    componentType: AU_TYPE_EFFECT,
    componentSubType: HOMECRATE_GRAIN_SUBTYPE,
    componentManufacturer: HOMECRATE_GRAIN_MANUFACTURER,
  },

  decodePreset: decodeGrainPreset,
  emptyPreset: () => ({ params: {}, raw: {} }),
  applyPreset: applyGrainPreset,

  assetRequests(preset): AssetRequest[] {
    if (!preset.grainLoopFilename) return [];
    return [
      {
        key: GRAIN_ASSET.loop,
        // `assets/samples/` is where the exporter writes these and what the
        // native library type is called. `GrainLoops` is the older folder
        // name, still present in archives written by earlier versions.
        library: 'samples',
        fallbackLibraries: ['GrainLoops'],
        filename: preset.grainLoopFilename,
        decode: 'audio',
        // A user loop that never made it into the export is common enough
        // that it must not fail the whole project load. The engine runs
        // without one; it just has nothing captured to granulate.
        optional: true,
      },
    ];
  },

  async bindLiveVoice(voice, material, binaries) {
    const wasm = binaries[GRAIN_KERNEL_SLOT] ?? binaries.grainFx;
    if (!wasm) return;
    await voice.loadKernel(GRAIN_KERNEL_SLOT, { wasm } satisfies GrainKernelPayload);
    const loop = grainLoopAsset(material);
    if (loop) {
      voice.sendKernel(GRAIN_KERNEL_SLOT, {
        type: 'loadLoop',
        samplesL: loop.samples,
        // Stereo loops keep both channels: downmixing here would throw away
        // real content the engine can use.
        samplesR: loop.samplesR ?? null,
      } satisfies GrainKernelMessage);
    }
  },
};
