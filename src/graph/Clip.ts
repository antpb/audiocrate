import type { FadeCurve } from '../clip/fades';
import { fadeCurveName } from '../clip/fades';
import type { SampleRegion, WarpSegment } from '../clip/region';

/**
 * The subset of the real (browser) AudioBuffer a Clip depends on. A narrow
 * structural type, not `globalThis.AudioBuffer` directly, so a test or an
 * `OfflineRenderer` can hand a Clip a plain in-memory buffer without an
 * AudioContext existing (same reasoning as AudioContextLike.ts).
 */
export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface ClipOptions {
  buffer: AudioBufferLike;
  name?: string;
  /** File-time trim. Offset on the timeline lives on ScheduledClip.at. */
  region?: SampleRegion;
  /** 1 = none. 2 = twice as long / half speed. Ignored when warpSegments is set. */
  stretchRatio?: number;
  warpSegments?: WarpSegment[] | null;
  fadeInSec?: number;
  fadeOutSec?: number;
  fadeInCurve?: FadeCurve | string;
  fadeOutCurve?: FadeCurve | string;
  /** Static clip gain in dB. <= -60 is silence. */
  gainDb?: number;
  crossfadeToNextSec?: number;
  crossfadeCurve?: FadeCurve | string;
}

let nextClipId = 1;

/** A buffer plus an AudioMaterial chain, placed on a track. */
export class Clip {
  readonly id: number = nextClipId++;
  name: string;
  readonly buffer: AudioBufferLike;
  readonly region: SampleRegion;
  readonly stretchRatio: number;
  readonly warpSegments: WarpSegment[] | null;
  fadeInSec: number;
  fadeOutSec: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
  gainDb: number;
  crossfadeToNextSec: number;
  crossfadeCurve: FadeCurve;

  constructor(options: ClipOptions) {
    this.buffer = options.buffer;
    this.name = options.name ?? `Clip ${this.id}`;
    this.region = options.region ?? { trimStartSec: 0, trimEndSec: null };
    this.stretchRatio =
      options.stretchRatio != null && options.stretchRatio > 0 ? options.stretchRatio : 1;
    this.warpSegments = options.warpSegments ?? null;
    this.fadeInSec = Math.max(0, options.fadeInSec ?? 0);
    this.fadeOutSec = Math.max(0, options.fadeOutSec ?? 0);
    this.fadeInCurve = fadeCurveName(options.fadeInCurve, 'linear');
    this.fadeOutCurve = fadeCurveName(options.fadeOutCurve, 'linear');
    this.gainDb = options.gainDb ?? 0;
    this.crossfadeToNextSec = Math.max(0, options.crossfadeToNextSec ?? 0);
    this.crossfadeCurve = fadeCurveName(options.crossfadeCurve, 'equalPower');
  }
}
