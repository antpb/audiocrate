/**
 * Stamp clip PCM at the live AudioContext rate without interpolating.
 * Creating the buffer at ctx.sampleRate and playing at fileRate / ctx.sampleRate
 * keeps speed correct without resampling the whole file on Play.
 */

const stamped = new WeakMap<Float32Array, Map<number, AudioBuffer>>();

export function clipRateScale(srcRate: number, destRate: number): number {
  const from = srcRate > 0 ? srcRate : destRate;
  const to = destRate > 0 ? destRate : from;
  if (!(from > 0) || !(to > 0)) return 1;
  return from / to;
}

export function bufferFromSample(
  ctx: AudioContext,
  sample: { samples: Float32Array; samplesR?: Float32Array; sampleRate: number },
): AudioBuffer {
  const destRate = ctx.sampleRate;
  const cached = stamped.get(sample.samples)?.get(destRate);
  if (cached) return cached;
  const right = sample.samplesR && sample.samplesR.length >= 2 ? sample.samplesR : undefined;
  const frames = right ? Math.min(sample.samples.length, right.length) : sample.samples.length;
  const buffer = ctx.createBuffer(right ? 2 : 1, Math.max(1, frames), destRate);
  buffer.copyToChannel(sample.samples.subarray(0, frames), 0);
  if (right) buffer.copyToChannel(right.subarray(0, frames), 1);
  let byRate = stamped.get(sample.samples);
  if (!byRate) {
    byRate = new Map();
    stamped.set(sample.samples, byRate);
  }
  byRate.set(destRate, buffer);
  return buffer;
}

export function prepareClipBuffer(
  ctx: AudioContext,
  sample: { samples: Float32Array; samplesR?: Float32Array; sampleRate: number },
): { buffer: AudioBuffer; rateScale: number } {
  const srcRate = sample.sampleRate > 0 ? sample.sampleRate : ctx.sampleRate;
  return {
    buffer: bufferFromSample(ctx, sample),
    rateScale: clipRateScale(srcRate, ctx.sampleRate),
  };
}
