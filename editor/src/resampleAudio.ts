/**
 * Decode-time PCM stays at the file rate. Play converts it to the
 * AudioContext rate so Chrome will accept the buffer and Safari plays
 * the right number of frames per second.
 */

import { resampleChannel } from '../../src/clip/resample';

const stamped = new WeakMap<Float32Array, Map<number, AudioBuffer>>();

export function bufferFromSample(
  ctx: AudioContext,
  sample: { samples: Float32Array; samplesR?: Float32Array; sampleRate: number },
): AudioBuffer {
  const destRate = ctx.sampleRate;
  const cached = stamped.get(sample.samples)?.get(destRate);
  if (cached) return cached;
  const srcRate = sample.sampleRate > 0 ? sample.sampleRate : destRate;
  const left = resampleChannel(sample.samples, srcRate, destRate);
  const right =
    sample.samplesR && sample.samplesR.length >= 2
      ? resampleChannel(sample.samplesR, srcRate, destRate)
      : undefined;
  const frames = right ? Math.min(left.length, right.length) : left.length;
  const buffer = ctx.createBuffer(right ? 2 : 1, Math.max(1, frames), destRate);
  buffer.copyToChannel(left.subarray(0, frames), 0);
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
  return {
    buffer: bufferFromSample(ctx, sample),
    rateScale: 1,
  };
}
