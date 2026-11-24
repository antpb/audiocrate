/**
 * Audio that arrives over the network while it plays, placed on a track
 * like a Clip.
 *
 * A `Clip` holds its whole decoded buffer, which is what lets the
 * transport schedule it sample-accurately, but it also means a five-minute
 * song costs about 115 MB of memory and cannot start until it has fully
 * downloaded. A `StreamClip` instead plays from a `StreamSource`: something
 * that can produce audio from a media position, fetching as it goes.
 *
 * The transport stays the one scheduling origin. `ScenePlayback` tells the
 * source "media time `offsetSec` is heard at context time `when`", exactly
 * as it tells a buffer source, and routes the source's node through the
 * track's chain (clip gain, inserts, fader, pan, master), so meters,
 * analyzers and AudioMaterials see it like any clip. What a buffer never
 * does is run out: when the network falls behind, the source reports it and
 * `holdWhileBuffering` (`stream/bufferingGuard.ts`) pauses the transport at
 * the position actually heard, then plays again from there. A stall is a
 * pause, never drift.
 *
 * Not supported on a stream (use a Clip for these): trims, fades, stretch,
 * warp, crossfades, and offline rendering. `OfflineRenderer` and
 * `bakeTrackInserts` only see `track.clips`.
 */

/** Anything with Web Audio's connect/disconnect. */
export interface StreamOutputNode {
  connect(destination: unknown): unknown;
  disconnect(destination?: unknown): void;
}

export interface StreamSource {
  /** Length of the media in seconds. */
  readonly durationSec: number;
  /**
   * The node this source plays through in `ctx`. Created once per context
   * and reused: a media element can only ever have one source node.
   */
  outputFor(ctx: unknown): StreamOutputNode;
  /** Make media time `offsetSec` audible at context time `when`. */
  start(when: number, offsetSec: number): void;
  /** Stop producing audio. Buffered data may be kept for a later start. */
  stop(): void;
  /** The media position being heard now, in seconds. */
  mediaTimeSec(): number;
  /** Seconds of media ready to play from `atSec` without waiting on the network. */
  bufferedAheadSec(atSec: number): number;
  /**
   * Called with `true` when playback has stopped for want of data, and
   * `false` when it could continue. Returns an unsubscribe function.
   */
  onStall(listener: (stalled: boolean) => void): () => void;
}

export interface StreamClipOptions {
  source: StreamSource;
  name?: string;
  /** Static gain in dB. <= -60 is silence. */
  gainDb?: number;
}

let nextStreamClipId = 1_000_000_000;

export class StreamClip {
  /** Drawn from a separate range from Clip ids, so a plan never confuses the two. */
  readonly id: number = nextStreamClipId++;
  name: string;
  readonly source: StreamSource;
  gainDb: number;

  constructor(options: StreamClipOptions) {
    this.source = options.source;
    this.name = options.name ?? `Stream ${this.id}`;
    this.gainDb = options.gainDb ?? 0;
  }

  get durationSec(): number {
    return this.source.durationSec;
  }
}
