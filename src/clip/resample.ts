import type { AudioBufferLike } from '../graph/Clip';

const resampled = new WeakMap<Float32Array, Map<number, Float32Array>>();

export function resampleChannel(src: Float32Array, srcRate: number, destRate: number): Float32Array {
  const from = srcRate > 0 ? srcRate : destRate;
  const to = destRate > 0 ? destRate : from;
  if (!(from > 0) || !(to > 0) || from === to || src.length === 0) return src;
  const hit = resampled.get(src)?.get(to);
  if (hit) return hit;
  const destLen = Math.max(1, Math.round((src.length * to) / from));
  const out = new Float32Array(destLen);
  const scale = from / to;
  const last = src.length - 1;
  for (let i = 0; i < destLen; i++) {
    const x = i * scale;
    const i0 = Math.min(last, Math.floor(x));
    const i1 = Math.min(last, i0 + 1);
    const frac = x - i0;
    out[i] = src[i0]! * (1 - frac) + src[i1]! * frac;
  }
  let byRate = resampled.get(src);
  if (!byRate) {
    byRate = new Map();
    resampled.set(src, byRate);
  }
  byRate.set(to, out);
  return out;
}

export function resampleAudioBufferLike(buffer: AudioBufferLike, destRate: number): AudioBufferLike {
  const srcRate = buffer.sampleRate > 0 ? buffer.sampleRate : destRate;
  if (!(destRate > 0) || srcRate === destRate) return buffer;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) =>
    resampleChannel(buffer.getChannelData(ch), srcRate, destRate),
  );
  const length = channels[0]?.length ?? 0;
  return {
    sampleRate: destRate,
    length,
    numberOfChannels: channels.length,
    getChannelData: (channel: number) => {
      const data = channels[channel];
      if (!data) throw new RangeError(`resampleAudioBufferLike: no channel ${channel}`);
      return data;
    },
  };
}
