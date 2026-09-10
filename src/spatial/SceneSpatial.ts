import type { AudioBufferLike } from '../graph/Clip';
import { buildSpatialMeta, type SpatialMetaEntry } from './meta';
import { SpatialListener } from './SpatialListener';
import { SpatialSource } from './SpatialSource';
import { encodeAmbisonics, type AmbisonicEncodeOptions, type AmbisonicEncodeResult } from './encode';

/**
 * `scene.spatial.listener` and `scene.spatial.export.toAmbisonics`.
 */
export class SceneSpatial {
  listener: SpatialListener = new SpatialListener();
  private readonly sourceList: SpatialSource[] = [];

  add(source: SpatialSource): SpatialSource {
    this.sourceList.push(source);
    return source;
  }

  remove(source: SpatialSource): boolean {
    const index = this.sourceList.indexOf(source);
    if (index === -1) return false;
    this.sourceList.splice(index, 1);
    return true;
  }

  get sources(): readonly SpatialSource[] {
    return this.sourceList;
  }

  meta(): SpatialMetaEntry[] {
    return buildSpatialMeta(this.sourceList);
  }

  readonly export = {
    toAmbisonics: (options: AmbisonicEncodeOptions = {}): AmbisonicEncodeResult => {
      const layers = this.sourceList.map((source) => {
        const buffer: AudioBufferLike | undefined = source.clip?.buffer;
        const samples = buffer ? mixToMono(buffer) : new Float32Array(0);
        return {
          samples,
          position: source.isGlobal ? null : source.position,
          volume: source.volume,
        };
      });
      return encodeAmbisonics(layers, options);
    },
  };
}

function mixToMono(buffer: AudioBufferLike): Float32Array {
  const out = new Float32Array(buffer.length);
  const n = Math.max(1, buffer.numberOfChannels);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < out.length; i++) out[i]! += (data[i] ?? 0) / n;
  }
  return out;
}
