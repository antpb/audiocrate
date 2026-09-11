import type { AudioContextLike } from './AudioContextLike';
import { SceneNotStartedError } from './errors';
import { Transport, type PlaybackOrigin, type TransportHost } from './Transport';
import { Bus } from './graph/Bus';
import type { AudioBufferLike } from './graph/Clip';
import type { Track } from './graph/Track';
import type { AudioMaterial } from './graph/AudioMaterial';
import { planScenePlayback } from './playback/plan';
import { MidiPlayback, type MidiVoiceTarget } from './playback/MidiPlayback';
import { ScenePlayback } from './playback/ScenePlayback';
import { bakeTrackInserts, type BakeTrackInsertsOptions } from './playback/bakeInserts';
import { prepareLiveVoices, disposeLiveVoices, type LiveVoiceRenderer, type LiveWasmBinaries, type LiveSceneVoices } from './playback/liveVoices';
import type { VoiceHandle } from './renderers/WebAudioRenderer';
import { HostedAutomationBridge } from './playback/hostedAutomation';
import { InputMonitor, type MonitorTrackConfig, type MonitorStart } from './playback/InputMonitor';
import type { HostedAutomationTrack, HostedAutomationWrite } from './automation/hosted';
import { SceneSpatial } from './spatial/SceneSpatial';

export interface AudioSceneOptions {
  sampleRate?: number;
  /**
   * Injectable context factory. Defaults to the real global `AudioContext`.
   * Tests and `OfflineRenderer` pass their own so `AudioScene`
   * never has to run against a hardware audio device.
   */
  createContext?: (sampleRate?: number) => AudioContextLike;
}

function defaultCreateContext(sampleRate?: number): AudioContextLike {
  const Ctor = (globalThis as { AudioContext?: new (options?: { sampleRate?: number }) => AudioContextLike })
    .AudioContext;
  if (!Ctor) {
    throw new Error(
      'No global AudioContext in this environment; pass `createContext` explicitly (tests, OfflineRenderer, non-browser hosts).',
    );
  }
  return new Ctor(sampleRate ? { sampleRate } : undefined);
}

/**
 * Owns its AudioContext, its Transport, and its node graph as instance
 * state, never module-level globals: two scenes never share a transport,
 * and a test can construct a scene, render it offline, and dispose it
 * without touching anything another test depends on. There is no
 * `Audiocrate.getTransport()` singleton.
 */
export class AudioScene implements TransportHost {
  readonly transport: Transport;
  /** The scene's own master bus; every track ultimately sums into this. */
  readonly master: Bus = new Bus({ name: 'Master' });
  /** Listener, point sources, FOA export. */
  readonly spatial = new SceneSpatial();

  private readonly options: AudioSceneOptions;
  private context: AudioContextLike | null = null;
  private startingPromise: Promise<void> | null = null;
  private readonly trackList: Track[] = [];
  readonly playback = new ScenePlayback();
  readonly midiPlayback = new MidiPlayback();
  /** Input monitoring. Mutually exclusive with playback, see `startMonitoring`. */
  readonly monitor = new InputMonitor();
  private bakedInserts: Map<number, AudioBufferLike> = new Map();
  private liveVoices: LiveSceneVoices | null = null;
  /** Hosted-project automation, applied to live voices by whatever clock the host runs. See `setHostedAutomationLanes`. */
  readonly hostedAutomation = new HostedAutomationBridge();

  constructor(options: AudioSceneOptions = {}) {
    this.options = options;
    this.transport = new Transport(this);
    // Play, pause, seek and tempo all republish, and every live voice hears
    // it. A graph reading `transport` nodes is otherwise stuck at whatever
    // the position was when its voice was created, which looks exactly like
    // a synced effect that ignores the transport.
    this.transport.onTransportChange((anchor) => {
      for (const handle of this.liveVoiceHandles()) handle.setTransport(anchor);
    });
  }

  /** Every live voice in the scene, master last. */
  private *liveVoiceHandles(): Generator<VoiceHandle> {
    if (!this.liveVoices) return;
    for (const track of this.liveVoices.tracks.values()) {
      for (const handle of track.inserts) yield handle;
      if (track.instrument) yield track.instrument;
    }
    for (const handle of this.liveVoices.master) yield handle;
  }

  /** Adds a track to the scene's graph and returns it, so `scene.addTrack(new Track(...))` can be assigned in one line. */
  addTrack<T extends Track>(track: T): T {
    this.trackList.push(track);
    return track;
  }

  removeTrack(track: Track): boolean {
    const index = this.trackList.indexOf(track);
    if (index === -1) return false;
    this.trackList.splice(index, 1);
    return true;
  }

  get tracks(): readonly Track[] {
    return this.trackList;
  }

  get isStarted(): boolean {
    return this.context !== null;
  }

  /**
   * Bakes every track's AudioMaterial chain into wet clip buffers that
   * `beginPlayback` schedules instead of the dry ones. Offline-bake before
   * scheduling, because `transport.play()` stays synchronous and cannot
   * await WASM setup itself. Must be called (again, if state changed)
   * before the next `play()`; there is no automatic cache invalidation.
   * See `playback/bakeInserts.ts`.
   */
  async prepareTrackInserts(options: BakeTrackInsertsOptions = {}): Promise<void> {
    this.bakedInserts = await bakeTrackInserts(this.trackList, options);
  }

  /**
   * Creates live instrument + insert voices for every track and the master
   * bus (`playback/liveVoices.ts`), so a track's plugins run for real during
   * `transport.play()` instead of being baked into a static buffer: needed
   * for real-time automation and MIDI-driven instruments, which a baked
   * buffer cannot support (nothing to write automation into once it is
   * rendered). `prepareTrackInserts` remains the path for offline or
   * non-interactive rendering. Must be called (again,
   * if tracks/materials/instrument changed) before the next `play()`, for
   * the same "no await inside sync play()" reason as `prepareTrackInserts`.
   * Disposes any previously-prepared live voices first.
   */
  async prepareLiveVoices(renderer: LiveVoiceRenderer, wasm: LiveWasmBinaries = {}): Promise<void> {
    if (this.liveVoices) disposeLiveVoices(this.liveVoices);
    this.liveVoices = await prepareLiveVoices(renderer, this.trackList, this.master, wasm);
    // Automation follows the voices, not the transport. `startPlayback` binds
    // again for its own freshly built graph, but binding only there meant a
    // scene with live voices and no `play()` (an armed track under the input
    // monitor, which is where the one live insert now lives) had automation
    // that resolved to nothing and wrote nothing, silently.
    this.hostedAutomation.bind(this.liveVoices, this.trackList, this.master);
    // A voice created mid-song starts at the current position rather than at
    // beat zero, for the same reason automation chases on start: arriving
    // late is not a reason to be wrong about where the song is.
    this.publishTransport();
  }

  /** Pushes the transport's current anchor to every live voice. */
  publishTransport(): void {
    const anchor = this.transport.anchor;
    for (const handle of this.liveVoiceHandles()) handle.setTransport(anchor);
  }

  /**
   * Last insert node for a track, or null if that track is dry. Wet capture
   * taps this point: post-plugin, upstream of the fader and pan.
   */
  lastInsertNode(trackId: number): unknown | null {
    const inserts = this.liveVoices?.tracks.get(trackId)?.inserts;
    if (!inserts?.length) return null;
    return inserts[inserts.length - 1]!.node;
  }

  /** Voices `prepareLiveVoices` last built, or null if none are armed. */
  get preparedLiveVoices(): LiveSceneVoices | null {
    return this.liveVoices;
  }

  /** Tears down any live voices `prepareLiveVoices` created, if there are any. */
  disposeLiveVoices(): void {
    if (this.liveVoices) {
      disposeLiveVoices(this.liveVoices);
      this.liveVoices = null;
    }
    this.hostedAutomation.reset();
  }

  /**
   * Installs a hosted project's automation payload (`buildAutomationPayload`
   * shape). The lanes are bound to live voices on the next `play()`; call
   * `applyHostedAutomationAt(timelineMs)` from the host's own progress clock
   * to actually write them. Audiocrate runs no timer of its own.
   */
  setHostedAutomationLanes(lanes: HostedAutomationTrack[]): void {
    this.hostedAutomation.setLanes(lanes);
  }

  /** Evaluates the installed lanes at a timeline position and writes the ones that moved. Returns what it applied. */
  applyHostedAutomationAt(timelineMs: number): HostedAutomationWrite[] {
    return this.hostedAutomation.apply(timelineMs);
  }

  /**
   * Starts input monitoring for the given armed tracks: `monitor` tracks are
   * audible through their own insert chain (`prepareLiveVoices` must have run
   * for a plugin chain to be in that path), `armed` tracks are metering only.
   *
   * Monitoring and playback are mutually exclusive: they share live voice
   * objects, and one `AudioWorkletNode` connected into both graphs would
   * sum into both, so this stops playback first rather than letting the
   * two overlap.
   */
  startMonitoring(configs: readonly MonitorTrackConfig[]): MonitorStart {
    if (!this.context) throw new SceneNotStartedError('scene.startMonitoring()');
    if (this.transport.state === 'playing') this.transport.stop();
    return this.monitor.start(this.context, this.trackList, this.master, configs, this.liveVoices ?? undefined);
  }

  stopMonitoring(): void {
    this.monitor.stop();
  }

  audioClock(): number {
    if (!this.context) throw new SceneNotStartedError('reading audioClock');
    return this.context.currentTime;
  }

  beginPlayback(playheadSec: number): PlaybackOrigin {
    if (!this.context) throw new SceneNotStartedError('beginPlayback');
    // Playback suspends monitoring, the same direction native enforces. The
    // host is expected to notice and re-arm afterwards; crate just makes sure
    // the two graphs never hold the same voices at once.
    this.monitor.stop();
    const plan = planScenePlayback({
      tracks: this.trackList,
      master: this.master,
      timeContext: this.transport.timeContext,
      resolveOffsetSec: (track, clipIndex) => this.transport.resolve(track.clips[clipIndex]!.at),
      resolveMidiOffsetSec: (track, clipIndex) => this.transport.resolve(track.midiClips[clipIndex]!.at),
      playheadSec,
      sampleRate: this.context.sampleRate,
    });
    const buffers = new Map<number, AudioBufferLike>();
    const midiTargets = new Map<number, MidiVoiceTarget>();
    for (const track of this.trackList) {
      for (const scheduled of track.clips) {
        buffers.set(scheduled.clip.id, this.bakedInserts.get(scheduled.clip.id) ?? scheduled.clip.buffer);
      }
      // A bound AudioMaterial directly on `track.materials` (no
      // `prepareLiveVoices` involved) still works as a MIDI target.
      // `start.instrumentTargets` below (`track.instrument`, live-bound)
      // takes precedence when both exist for the same track.
      for (const material of track.materials) {
        if (material.isBound) {
          midiTargets.set(track.id, material);
          break;
        }
      }
    }
    const start = this.playback.start(this.context, this.trackList, this.master, plan, buffers, this.liveVoices ?? undefined);
    for (const [trackId, target] of start.instrumentTargets) midiTargets.set(trackId, target);
    this.midiPlayback.start(this.context, start.originCtx, plan.midiJobs, midiTargets, plan.midiCcJobs);

    // Re-bind hosted automation to this play()'s freshly built graph, then
    // chase once at the playhead so a lane that already moved before the
    // start position is heard immediately rather than at the next host tick.
    this.hostedAutomation.clearClipGainTargets();
    if (this.liveVoices) this.hostedAutomation.bind(this.liveVoices, this.trackList, this.master);
    for (const track of this.trackList) {
      const target = start.clipGainTargets.get(track.id);
      if (target && track.hostedTrackIndex !== undefined) {
        this.hostedAutomation.setClipGainTarget(track.hostedTrackIndex, target);
      }
    }
    this.hostedAutomation.apply(playheadSec * 1000);

    return { audibleOriginCtx: start.audibleOriginCtx };
  }

  pausePlayback(): void {
    this.midiPlayback.stop();
    this.playback.stop();
  }

  stopPlayback(): void {
    this.midiPlayback.stop();
    this.playback.stop();
  }

  /**
   * The only place the browser's autoplay-gesture requirement lives.
   * Resolves once the underlying AudioContext is actually running.
   * Idempotent: a second call while the first is still resolving, or after
   * it already has, returns the same outcome rather than creating a second
   * context.
   */
  async start(): Promise<void> {
    if (this.context) return;
    if (!this.startingPromise) {
      this.startingPromise = this.doStart();
    }
    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    const createContext = this.options.createContext ?? defaultCreateContext;
    const ctx = createContext(this.options.sampleRate);
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    this.context = ctx;
  }

  /**
   * The underlying context, for a renderer to attach to (`WebAudioRenderer`
   * needs `AudioContext` to load a worklet module and construct nodes).
   * Ordinary scene-graph code should go through `transport` / `currentTime`
   * instead.
   */
  get audioContext(): AudioContextLike {
    if (!this.context) {
      throw new SceneNotStartedError('reading scene.audioContext');
    }
    return this.context;
  }

  get currentTime(): number {
    if (!this.context) {
      throw new SceneNotStartedError('reading scene.currentTime');
    }
    return this.context.currentTime;
  }

  get sampleRate(): number {
    if (!this.context) {
      throw new SceneNotStartedError('reading scene.sampleRate');
    }
    return this.context.sampleRate;
  }

  /** Tears the scene down; a disposed scene can be started again like a fresh one. */
  async dispose(): Promise<void> {
    this.midiPlayback.stop();
    this.playback.stop();
    this.monitor.stop();
    const ctx = this.context;
    this.context = null;
    if (ctx) {
      await ctx.close();
    }
  }
}
