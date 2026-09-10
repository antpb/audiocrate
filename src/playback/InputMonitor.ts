import type { AudioContextLike } from '../AudioContextLike';
import type { Bus } from '../graph/Bus';
import type { Track } from '../graph/Track';
import type { LiveSceneVoices } from './liveVoices';
import type { VoiceHandle } from '../renderers/WebAudioRenderer';
import { asWebAudio, type TrackFader, type WebAudioBits } from './ScenePlayback';

/**
 * A live audio input, supplied by the host. Crate does not open devices:
 * on web this wraps a `MediaStreamAudioSourceNode` from `getUserMedia`, on
 * another host it could be anything with the same two methods. Same
 * injection style as `AudioContextLike`. Device assignment is host-local
 * and must not be published on a collab session.
 */
export interface LiveInputNode {
  connect(destination: unknown): void;
  /** Optional destination: omit only when tearing the node down entirely. */
  disconnect(destination?: unknown): void;
}

/**
 * What to do with one armed track's input: `monitor` is audible through
 * that track's chain, `armed` is metering only (the input is connected
 * to an analyser tap but never reaches the master).
 */
export type MonitorMode = 'monitor' | 'armed';

export interface MonitorTrackConfig {
  /** crate `Track.id`. */
  trackId: number;
  input: LiveInputNode;
  mode: MonitorMode;
}

export interface MonitorStart {
  /** Live fader/panner per monitored track, so a mixer can move a monitored channel. */
  trackFaders: Map<number, TrackFader>;
  /** Tracks whose input is audible (mode `monitor`). Metering-only tracks are excluded. */
  audibleTrackIds: number[];
  /**
   * Last insert node per monitored track, upstream of the fader/pan. Dry
   * tracks are omitted: wet capture rejects those as `NO_PLUGINS`.
   */
  postInsertTaps: Map<number, unknown>;
}

/**
 * Input monitoring, separate from `ScenePlayback`.
 *
 * The two are mutually exclusive: they share the same live voice objects
 * (`prepareLiveVoices`), and an `AudioWorkletNode` connected into two graphs
 * at once would sum into both. `AudioScene.startMonitoring` stops one before
 * starting the other. Starting playback tears monitoring down.
 *
 * The chain per monitored track is the same shape playback uses: a track
 * with no plugins is `input -> fader -> master`, and a track with plugins is
 * `input -> insert[0] -> ... -> fader -> master`.
 */
export class InputMonitor {
  lastStart: MonitorStart | null = null;
  private nodes: Array<{ disconnect(): void }> = [];
  private inputs: Array<{ input: LiveInputNode; dest: unknown }> = [];
  private voiceEdges: Array<{ node: { disconnect(dest?: unknown): void }; dest: unknown }> = [];
  private active = false;

  get isActive(): boolean {
    return this.active;
  }

  start(
    ctx: AudioContextLike,
    tracks: readonly Track[],
    master: Bus,
    configs: readonly MonitorTrackConfig[],
    liveVoices?: LiveSceneVoices,
  ): MonitorStart {
    this.stop();
    const web = asWebAudio(ctx);
    const trackFaders = new Map<number, TrackFader>();
    const audibleTrackIds: number[] = [];
    const postInsertTaps = new Map<number, unknown>();
    const start: MonitorStart = { trackFaders, audibleTrackIds, postInsertTaps };

    if (!web) {
      this.lastStart = start;
      this.active = configs.length > 0;
      return start;
    }

    const trackById = new Map<number, Track>();
    for (const track of tracks) trackById.set(track.id, track);

    const masterGain = web.createGain();
    masterGain.gain.value = master.muted ? 0 : master.volume;
    masterGain.connect(web.destination);
    this.nodes.push(masterGain);

    for (const config of configs) {
      const track = trackById.get(config.trackId);
      if (!track || track.muted) continue;

      if (config.mode === 'armed') {
        // Metering only: the host taps the input itself for levels. Nothing
        // is connected toward the master, so an armed-but-not-monitored
        // track cannot feed back through the speakers.
        continue;
      }

      const gain = web.createGain();
      gain.gain.value = track.volume;
      const panner = web.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, track.pan));
      gain.connect(panner);
      panner.connect(masterGain);
      this.nodes.push(gain, panner);
      trackFaders.set(track.id, { gain: gain.gain, pan: panner.pan });

      let entry: unknown = gain;
      const live = liveVoices?.tracks.get(track.id);
      if (live && live.inserts.length > 0) {
        entry = this.connectInserts(live.inserts, gain);
        postInsertTaps.set(track.id, live.inserts[live.inserts.length - 1]!.node);
      }

      config.input.connect(entry);
      this.inputs.push({ input: config.input, dest: entry });
      audibleTrackIds.push(track.id);
    }

    this.active = true;
    this.lastStart = start;
    return start;
  }

  stop(): void {
    for (const { input, dest } of this.inputs) {
      try {
        input.disconnect(dest);
      } catch {
        /* already disconnected */
      }
    }
    this.inputs = [];
    for (const { node, dest } of this.voiceEdges) {
      try {
        node.disconnect(dest);
      } catch {
        /* already disconnected */
      }
    }
    this.voiceEdges = [];
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.nodes = [];
    this.active = false;
  }

  /** Series wiring that remembers each edge so stop() does not `disconnect()` the whole worklet. */
  private connectInserts(voices: VoiceHandle[], dest: unknown): unknown {
    let entry = dest;
    for (let i = voices.length - 1; i >= 0; i--) {
      const node = voices[i]!.node as unknown as {
        connect(n: unknown): void;
        disconnect(dest?: unknown): void;
      };
      node.connect(entry);
      this.voiceEdges.push({ node, dest: entry });
      entry = voices[i]!.node;
    }
    return entry;
  }
}

/** Re-exported so a host building monitor graphs doesn't need to reach into ScenePlayback. */
export type { WebAudioBits };
