import { SceneNotStartedError } from './errors';
import type { Time, TimeContext } from './Time';
import type { TransportAnchor } from './asl/transportNodes';
import { TempoMap } from './TempoMap';

export type TransportState = 'stopped' | 'playing' | 'paused';

export interface PlaybackOrigin {
  audibleOriginCtx: number;
}

/** The slice of AudioScene that Transport needs, so the two can be tested independently. */
export interface TransportHost {
  readonly isStarted: boolean;
  audioClock?(): number;
  beginPlayback?(playheadSec: number): PlaybackOrigin | void;
  pausePlayback?(): void;
  stopPlayback?(): void;
}

/**
 * Lives as instance state on one AudioScene, never a module-level global:
 * two scenes' transports never share tempo or playback state, and a test
 * can drive one without touching another.
 */
export class Transport {
  ppqn = 24;
  /** Time-signature numerator. */
  beatsPerBar = 4;
  /** Time-signature denominator. 4 is a quarter-note beat, 8 is an eighth. */
  beatUnit = 4;

  private _state: TransportState = 'stopped';
  private _bpm = 120;
  private _tempoMap: TempoMap | null = null;
  private playheadSec = 0;
  private clockAtAudibleOrigin: number | null = null;
  private readonly changeListeners = new Set<(anchor: TransportAnchor) => void>();

  constructor(private readonly host: TransportHost) {}

  get state(): TransportState {
    return this._state;
  }

  get bpm(): number {
    return this._bpm;
  }

  /**
   * A tempo change is a transport change, so setting this republishes the
   * anchor. Without that, a graph reading `transport.bpm()` would keep the
   * old tempo until the next `play()`.
   *
   * With a tempo map set, this is the tempo **before the first change**, and
   * assigning it rebases the map while keeping the changes. That is what
   * "the song is now slower" means when the song already has a tempo change
   * in it, and it is why this rebases rather than throwing.
   */
  set bpm(value: number) {
    if (value === this._bpm) return;
    this._bpm = value;
    if (this._tempoMap && !this._tempoMap.isConstant) {
      this._tempoMap = new TempoMap(this._tempoMap.changes, value, this._tempoMap.baseCurve);
    } else if (this._tempoMap) {
      this._tempoMap = TempoMap.constant(value);
    }
    this.publish();
  }

  /**
   * The song's tempo over time. Null, the default, means one constant tempo
   * at `bpm`, and a scene that never sets one resolves every musical position
   * through exactly the expression it did before tempo maps existed.
   *
   * Setting a map does not change how anything is scheduled. It changes what
   * second a musical position falls on, which is the only question a tempo
   * map answers. One origin, PDC offsets from it, and everything in seconds
   * downstream: all unchanged.
   */
  get tempoMap(): TempoMap | null {
    return this._tempoMap;
  }

  set tempoMap(map: TempoMap | null) {
    this._tempoMap = map;
    if (map) this._bpm = map.baseBpm;
    this.publish();
  }

  /** The tempo at a point on the timeline, in seconds. */
  bpmAt(seconds: number): number {
    return this._tempoMap ? this._tempoMap.bpmAtSeconds(seconds) : this._bpm;
  }

  /** The tempo where the playhead is now, which is what a readout should show. */
  get currentBpm(): number {
    return this.bpmAt(this.position);
  }

  /** The playhead in beats rather than seconds. */
  get positionBeats(): number {
    return this.beatsAt(this.position);
  }

  private beatsAt(seconds: number): number {
    return this._tempoMap ? this._tempoMap.beatAtSeconds(seconds) : (seconds * this._bpm) / 60;
  }

  /**
   * The musical position, pinned to a moment on the audio clock, for a
   * renderer to hand to a graph's `transport` nodes.
   *
   * Beats come from the tempo map when there is one, and from the constant
   * tempo when there is not. `changes` carries every tempo change still
   * ahead, already in audio-clock time, so the audio thread follows one on
   * the exact sample without being told again.
   */
  get anchor(): TransportAnchor {
    const playing = this._state === 'playing';
    // While playing, anchor to the audible origin and the playhead it started
    // from, not to "now" and `position`. `position` clamps at zero, and the
    // audible origin is deliberately a little in the future (PDC plus
    // schedule-ahead), so reading the clock here would both clamp wrongly and
    // put every synced effect out by exactly that offset.
    // Before the scene starts there is no audio clock to read, and asking
    // for one throws. Zero: nothing is rendering yet,
    // so nothing can be anchored to a moment that has not happened.
    const clockNow = this.host.isStarted ? (this.host.audioClock?.() ?? 0) : 0;
    const atTime =
      playing && this.clockAtAudibleOrigin != null ? this.clockAtAudibleOrigin : clockNow;
    const fromSec = playing ? this.playheadSec : this.position;
    const beats = this.beatsAt(fromSec);
    const bpm = this.bpmAt(fromSec);
    // Starting or seeking into the middle of a ramp: the anchor carries the
    // slope of the span the playhead is actually inside, not the tempo at the
    // last marker. Without this a song resumed mid-accelerando would hold the
    // tempo it happened to be at when play was pressed.
    const inSpan = this._tempoMap?.segmentAt(beats);
    const anchorSlope = inSpan && inSpan.slope !== 0 ? inSpan.slope : 0;
    // Every tempo change still ahead, already converted to audio-clock time.
    // The audio thread then follows a tempo change on the exact sample rather
    // than whenever a main-thread timer got around to telling it, and it does
    // no musical arithmetic of its own to manage it.
    const changes = this._tempoMap
      ? this._tempoMap.segmentsFromBeat(beats).map((segment) => ({
          atTime: atTime + (segment.atSeconds - fromSec),
          beats: segment.atBeat,
          bpm: segment.bpm,
          ...(segment.slope !== 0 ? { slope: segment.slope } : {}),
        }))
      : [];
    return {
      atTime,
      beats,
      bpm,
      playing,
      beatsPerBar: this.beatsPerBar,
      beatUnit: this.beatUnit,
      ...(anchorSlope !== 0 ? { slope: anchorSlope } : {}),
      ...(changes.length > 0 ? { changes } : {}),
    };
  }

  /**
   * Fires whenever the anchor changes: play, pause, stop, seek, tempo. A
   * scene subscribes so its live voices are told; a host that drives voices
   * itself can subscribe instead.
   */
  onTransportChange(listener: (anchor: TransportAnchor) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Republishes the current anchor. Call after changing `beatsPerBar` or `beatUnit`. */
  publish(): void {
    if (this.changeListeners.size === 0) return;
    const anchor = this.anchor;
    for (const listener of this.changeListeners) listener(anchor);
  }

  /**
   * Timeline playhead in seconds. While playing this tracks the audible
   * origin (PDC + schedule-ahead), not the moment play() was called.
   */
  get position(): number {
    if (this._state === 'playing' && this.clockAtAudibleOrigin != null && this.host.audioClock) {
      return Math.max(0, this.playheadSec + (this.host.audioClock() - this.clockAtAudibleOrigin));
    }
    return this.playheadSec;
  }

  seek(seconds: number): void {
    this.assertStarted('transport.seek()');
    this.playheadSec = Math.max(0, seconds);
    this.clockAtAudibleOrigin = null;
    if (this._state === 'playing') this.startFrom(this.playheadSec);
    else this.publish();
  }

  play(): void {
    this.assertStarted('transport.play()');
    if (this._state === 'playing') return;
    this.startFrom(this.playheadSec);
  }

  pause(): void {
    this.assertStarted('transport.pause()');
    if (this._state !== 'playing') {
      this._state = 'paused';
      return;
    }
    this.playheadSec = this.position;
    this.clockAtAudibleOrigin = null;
    this.host.pausePlayback?.();
    this._state = 'paused';
    this.publish();
  }

  stop(): void {
    this.assertStarted('transport.stop()');
    this.playheadSec = 0;
    this.clockAtAudibleOrigin = null;
    this.host.stopPlayback?.();
    this._state = 'stopped';
    this.publish();
  }

  private startFrom(playheadSec: number): void {
    this.playheadSec = playheadSec;
    const origin = this.host.beginPlayback?.(playheadSec);
    this.clockAtAudibleOrigin = origin?.audibleOriginCtx ?? this.host.audioClock?.() ?? null;
    this._state = 'playing';
    // Published after the origin is captured, so the anchor names the moment
    // audio actually starts rather than the moment play() was called. Those
    // differ by the PDC and schedule-ahead offsets, and anchoring to the
    // wrong one puts every synced effect out by exactly that much.
    this.publish();
  }

  get timeContext(): TimeContext {
    return {
      bpm: this._bpm,
      ppqn: this.ppqn,
      beatsPerBar: this.beatsPerBar,
      beatUnit: this.beatUnit,
      // Omitted entirely when there is none, so `Time.toSeconds` takes the
      // same branch it always took rather than one that happens to agree.
      ...(this._tempoMap ? { tempoMap: this._tempoMap } : {}),
    };
  }

  /** Resolves a structured Time against this transport's current bpm/ppqn. */
  resolve(t: Time): number {
    return t.toSeconds(this.timeContext);
  }

  private assertStarted(action: string): void {
    if (!this.host.isStarted) {
      throw new SceneNotStartedError(action);
    }
  }
}
