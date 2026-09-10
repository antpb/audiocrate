import type { AudioBufferLike } from '../graph/Clip';
import { distanceAttenuation } from './distance';
import { foaGainsFromPoint, stereoPanFromY, type FOAGains } from './foa';

export interface AmbisonicLayer {
  samples: Float32Array;
  position: { x: number; y: number; z: number } | null;
  volume?: number;
  distance?: number;
}

export interface AmbisonicEncodeOptions {
  /** Only order 1 (FOA) is implemented. Higher orders throw. */
  order?: 1;
  sampleRate?: number;
}

export interface AmbisonicEncodeResult {
  foa: AudioBufferLike;
  stereo: AudioBufferLike;
  sampleRate: number;
}

function planarBuffer(channels: Float32Array[], sampleRate: number): AudioBufferLike {
  const length = channels[0]?.length ?? 0;
  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    getChannelData(channel: number) {
      return channels[channel] ?? new Float32Array(length);
    },
  };
}

/**
 * Mix mono layers into ACN/SN3D FOA (W Y Z X) plus the stereo AAC fallback.
 */
export function encodeAmbisonics(
  layers: AmbisonicLayer[],
  options: AmbisonicEncodeOptions = {},
): AmbisonicEncodeResult {
  if (options.order != null && options.order !== 1) {
    throw new RangeError(`encodeAmbisonics: only order 1 (FOA) is implemented, got ${options.order}`);
  }
  const sampleRate = options.sampleRate ?? 48000;
  const length = layers.reduce((max, layer) => Math.max(max, layer.samples.length), 0);
  const w = new Float32Array(length);
  const y = new Float32Array(length);
  const z = new Float32Array(length);
  const x = new Float32Array(length);
  const left = new Float32Array(length);
  const right = new Float32Array(length);

  for (const layer of layers) {
    const gains: FOAGains = foaGainsFromPoint(layer.position);
    const att = distanceAttenuation(layer.distance ?? (layer.position ? Math.hypot(layer.position.x, layer.position.y, layer.position.z) : 1));
    const vol = (layer.volume ?? 1) * att;
    const pan = layer.position ? stereoPanFromY(gains.y) : { l: 0.5, r: 0.5 };
    const src = layer.samples;
    for (let i = 0; i < src.length; i++) {
      const s = src[i]! * vol;
      w[i]! += gains.w * s;
      y[i]! += gains.y * s;
      z[i]! += gains.z * s;
      x[i]! += gains.x * s;
      left[i]! += s * pan.l;
      right[i]! += s * pan.r;
    }
  }

  return {
    foa: planarBuffer([w, y, z, x], sampleRate),
    stereo: planarBuffer([left, right], sampleRate),
    sampleRate,
  };
}
