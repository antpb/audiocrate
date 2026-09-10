import type { AudioBufferLike } from '../graph/Clip';

/**
 * Fade curves. linear is the default. equalPower / sCurve are what
 * projectCrossfades writes so an overlap sums to constant perceived
 * loudness. x is progress 0..1 toward full gain.
 */
export type FadeCurve = 'linear' | 'equalPower' | 'sCurve';

export function fadeShape(x: number, curve: string = 'linear'): number {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  if (curve === 'equalPower') return Math.sin((t * Math.PI) / 2);
  if (curve === 'sCurve') return t * t * (3 - 2 * t);
  return t;
}

/** clipGainDb <= -60 is silence. Otherwise 10^(dB/20). */
export function clipGainLinear(gainDb: number): number {
  if (!(gainDb > -60)) return 0;
  return 10 ** (gainDb / 20);
}

export function isFadeCurve(value: unknown): value is FadeCurve {
  return value === 'linear' || value === 'equalPower' || value === 'sCurve';
}

export function fadeCurveName(value: unknown, fallback: FadeCurve): FadeCurve {
  return isFadeCurve(value) ? value : fallback;
}

export interface ApplyClipFadesOptions {
  gainDb?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  fadeInCurve?: string;
  fadeOutCurve?: string;
  /** File-time start of the clip window. Fade-in is anchored here. */
  trimStartSec?: number;
  /** File-time end of the clip window. Fade-out is anchored here. */
  trimEndSec?: number;
  /**
   * Timeline-to-file scale. Fade lengths are authored in timeline seconds.
   * Audiocrate keeps the source buffer and a playbackRate, so fade lengths in
   * file time are fadeSec * playbackRate.
   */
  playbackRate?: number;
}

function copyBuffer(buffer: AudioBufferLike): AudioBufferLike {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => {
    const src = buffer.getChannelData(ch);
    const out = new Float32Array(src.length);
    out.set(src);
    return out;
  });
  return {
    sampleRate: buffer.sampleRate,
    length: buffer.length,
    numberOfChannels: buffer.numberOfChannels,
    getChannelData: (channel: number) => {
      const data = channels[channel];
      if (!data) throw new RangeError(`applyClipGainAndFades: no channel ${channel}`);
      return data;
    },
  };
}

/**
 * Copies the buffer and applies static clip gain plus edge fades in place
 * on the copy. Fade lengths are timeline seconds; they are converted to
 * source frames via playbackRate so a stretched clip still fades in
 * wall-clock time. The original buffer is never mutated.
 */
export function applyClipGainAndFades(buffer: AudioBufferLike, opts: ApplyClipFadesOptions = {}): AudioBufferLike {
  const gainDb = opts.gainDb ?? 0;
  const fadeInSec = Math.max(0, opts.fadeInSec ?? 0);
  const fadeOutSec = Math.max(0, opts.fadeOutSec ?? 0);
  if (gainDb === 0 && fadeInSec <= 0 && fadeOutSec <= 0) return buffer;

  const rate = opts.playbackRate != null && opts.playbackRate > 0 ? opts.playbackRate : 1;
  const gain = clipGainLinear(gainDb);
  const sr = buffer.sampleRate;
  const fileDur = buffer.length / sr;
  const trimStart = Math.max(0, opts.trimStartSec ?? 0);
  const trimEnd = opts.trimEndSec != null && opts.trimEndSec > trimStart ? Math.min(opts.trimEndSec, fileDur) : fileDur;
  const fadeInFileSec = fadeInSec * rate;
  const fadeOutFileSec = fadeOutSec * rate;
  const fadeInEnd = trimStart + fadeInFileSec;
  const fadeOutStart = trimEnd - fadeOutFileSec;
  const out = copyBuffer(buffer);

  for (let ch = 0; ch < out.numberOfChannels; ch++) {
    const data = out.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      let scale = gain;
      if (fadeInFileSec > 0 && t >= trimStart && t < fadeInEnd) {
        scale *= fadeShape((t - trimStart) / fadeInFileSec, opts.fadeInCurve ?? 'linear');
      }
      if (fadeOutFileSec > 0 && t > fadeOutStart && t <= trimEnd) {
        scale *= fadeShape((trimEnd - t) / fadeOutFileSec, opts.fadeOutCurve ?? 'linear');
      }
      data[i] *= scale;
    }
  }
  return out;
}
