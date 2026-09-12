/**
 * A crate AudioMaterial as the source of a `THREE.Audio`.
 *
 * three.js `Audio` is an `Object3D` that owns a `GainNode` and plays an
 * `AudioBuffer`. `PositionalAudio` puts a `PannerNode` in front of it.
 * Neither decides where the sound comes from. Every three.js audio example
 * begins by loading a file.
 *
 * `Audio.setNodeSource(audioNode)` accepts any `AudioNode`, the same seam
 * as `setMediaElementSource` and `setMediaStreamSource`. A crate voice is
 * an `AudioNode`: one `AudioWorkletNode` per AudioMaterial, running a fused ASL
 * graph.
 *
 * ```
 * three.js:  AudioLoader -> AudioBuffer -> Audio.setBuffer     -> panner -> listener
 * crate:     AudioMaterial    -> ASL graph   -> Audio.setNodeSource -> panner -> listener
 * ```
 *
 * A buffer is fixed samples. A graph is live: parameters move, the world
 * can drive them, and many objects can share one description while sounding
 * different.
 *
 * ## What this does not do
 *
 * It does not create an `AudioContext` or an `AudioListener`. XR Publisher
 * owns exactly one of each, mounted on the camera. A second context would
 * be silent on iOS, unpannable everywhere, and would not be resumed. The
 * listener is passed in, and its context is the context.
 *
 * The engine only calls `ctx.resume()` on a tap. That is not enough on
 * iPhone Safari: the same turn also needs a silent buffer, a keep-alive,
 * and an HTML MediaStream sink (see `hostedAudio.ts`). `createCrateAudio`
 * is async, so it cannot be the unlock. The host must call
 * `unlockHostedAudio` from the gesture, before any `await`.
 */
import { AudioMaterial, WebAudioRenderer, type ASLGraphDescriptor, type VoiceHandle } from './crate';
import { attachNodeToHtmlSink } from './hostedAudio';

/**
 * The parts of `THREE` this file needs, and no more.
 *
 * A structural type rather than an import, for the reason every XR Publisher
 * plugin has: the engine's three is already on the page as `window.THREE`,
 * and bundling a second copy breaks `instanceof` checks, breaks TSL node
 * identity, and doubles the payload. Declaring the shape instead means this
 * package has no three dependency at all, which also makes it testable in
 * Node against a handful of fakes.
 */
export interface ThreeAudioLike {
  setNodeSource(node: AudioNode): unknown;
  setVolume(value: number): unknown;
  /**
   * The object's own `GainNode`, which three.js exposes directly as `.gain`.
   *
   * **Not `getOutput()`.** `Audio.getOutput()` returns this gain node, but
   * `PositionalAudio` overrides it to return its `PannerNode`, and a
   * `PannerNode` has no `.gain`. Reading `getOutput().gain` works for a
   * plain `Audio` and throws for every spatialised one.
   *
   *   source -> panner -> gain -> listener -> destination
   */
  gain: GainNode;
  disconnect(): unknown;
  /** Present on `PositionalAudio` only. See `CrateAudioOptions.spatial`. */
  setRefDistance?(value: number): unknown;
  setRolloffFactor?(value: number): unknown;
  setMaxDistance?(value: number): unknown;
  setDistanceModel?(value: string): unknown;
}

export interface ThreeListenerLike {
  context: AudioContext;
  /**
   * The listener mix, already connected to `destination` by three.js.
   * On iOS it is also tapped into the HTML sink, and disconnected from
   * destination once that element is playing, same as the editor.
   */
  gain?: GainNode;
}

export interface ThreeNamespaceLike {
  Audio: new (listener: ThreeListenerLike) => ThreeAudioLike;
  PositionalAudio: new (listener: ThreeListenerLike) => ThreeAudioLike;
}

/**
 * One renderer per `AudioContext`, shared by every `CrateAudio` on it.
 *
 * `WebAudioRenderer` holds the `addModule` promise, so a renderer per sound
 * would mean one worklet-module load per sound: forty stones would issue
 * forty `addModule` calls for the same code, each one a fetch and a compile
 * on a thread that is trying to make audio. Keyed by context rather than
 * global because a page can legitimately have more than one, and a module
 * added to one context means nothing to another.
 *
 * A `WeakMap` so a discarded context does not keep its renderer alive.
 */
const renderers = new WeakMap<AudioContext, WebAudioRenderer>();

/**
 * Milliseconds between the two halves of a retrigger. See `CrateAudio.strike`.
 * Must exceed one render quantum (128 samples, 2.7 ms at 48 kHz).
 */
const STRIKE_GAP_MS = 24;

export function rendererFor(context: AudioContext, workletUrl?: string): WebAudioRenderer {
  let renderer = renderers.get(context);
  if (!renderer) {
    renderer = new WebAudioRenderer(context, workletUrl ? { workletUrl } : {});
    renderers.set(context, renderer);
  }
  return renderer;
}

export interface CrateAudioOptions {
  /**
   * Spatialised. `false` gives a plain `THREE.Audio`, for a source that
   * should not pan with the listener.
   */
  positional?: boolean;
  /** Initial gain on the three.js side. The graph's own levels are params. */
  volume?: number;
  /**
   * Parameters to apply before the voice is connected.
   *
   * Applied *before* connection, on purpose: a voice that connects at its
   * defaults and is corrected a frame later plays one frame of the wrong
   * sound, and with a resonator or a drone that frame is an audible click.
   */
  params?: Record<string, number>;
  /**
   * Overrides the worklet module URL. The bundled default is crate's own
   * (pure ASL plus the core convolver), inlined into this file as a blob.
   */
  workletUrl?: string;
  /**
   * Panner distance settings, applied when the object is positional.
   *
   * Web Audio defaults `refDistance` to **1**. The default inverse model
   * attenuates by roughly `1/d`, so an object twenty units away plays at a
   * twentieth of its level.
   *
   * Defaults here: ref 6, rolloff 1.2, max 60.
   */
  spatial?: {
    refDistance?: number;
    rolloffFactor?: number;
    maxDistance?: number;
    distanceModel?: 'linear' | 'inverse' | 'exponential';
  };
}

/**
 * A live crate voice wired into a three.js audio object.
 *
 * Created by `createCrateAudio`, which is async because building a voice
 * means loading a worklet module and that is not something a constructor can
 * wait for.
 */
export class CrateAudio {
  constructor(
    /** The three.js object. Add it to an `Object3D` to place the sound. */
    readonly audio: ThreeAudioLike,
    /** The crate voice. Params, notes, transport and analysis all live here. */
    readonly voice: VoiceHandle,
    private readonly context: AudioContext,
  ) {}

  /**
   * Moves one parameter. The equivalent for a buffer-backed `THREE.Audio` is
   * to render a different buffer.
   */
  set(name: string, value: number): this {
    this.voice.setParam(name, value);
    return this;
  }

  /** Several at once, for a per-frame update that drives more than one. */
  setAll(params: Record<string, number>): this {
    for (const name in params) this.voice.setParam(name, params[name]!);
    return this;
  }

  /**
   * Gate the voice on. For an AudioMaterial with an envelope this is a note; for a
   * drone it is the start.
   *
   * Note that unlike `THREE.Audio.play()` this is not playback control:
   * `setNodeSource` sets `hasPlaybackControl` to false, so `play`, `pause`
   * and `stop` on the three.js object throw. A crate voice is always running,
   * exactly like an `OscillatorNode` source would be, and what starts and
   * stops is the sound the graph is making. `dispose()` is how it actually
   * goes away.
   */
  noteOn(params: Record<string, number> = {}): this {
    this.voice.noteOn(params);
    return this;
  }

  noteOff(): this {
    this.voice.noteOff();
    return this;
  }

  /**
   * Retriggers a one-shot voice.
   *
   * `noteOn` alone will not do it. `noteOn` sets the voice's gate true, and
   * every trigger in ASL fires on a **rising edge**: an envelope checks
   * `gate && !lastGate`, and so does `impulse()`. A voice that is already
   * gated is already high, so a second `noteOn` changes nothing.
   *
   * The two halves of a gate cycle have to land in different render quanta.
   * Posting `noteOff` and `noteOn` in one turn is no better than posting
   * `noteOn` twice: the worklet applies both between blocks, nothing renders
   * in between, and the edge never exists. The scheduled-MIDI path does not
   * help either, since it routes to kernels and never touches the gate.
   *
   * The gap has to exceed one 128-sample quantum (2.7 ms at 48 kHz).
   * `STRIKE_GAP_MS` is 24.
   */
  strike(params: Record<string, number> = {}): this {
    this.voice.noteOff();
    if (this.strikeTimer !== undefined) clearTimeout(this.strikeTimer);
    this.strikeTimer = setTimeout(() => {
      this.strikeTimer = undefined;
      // Disposed while the gap was elapsing.
      if (this.disposed) return;
      this.voice.noteOn(params);
    }, STRIKE_GAP_MS) as unknown as number;
    return this;
  }

  private strikeTimer: number | undefined;

  /** Gain on the three.js side, in front of the panner. */
  setVolume(value: number): this {
    this.audio.setVolume(value);
    return this;
  }

  /**
   * Ramps the three.js gain rather than stepping it.
   *
   * A per-frame `setVolume` on a distance fade steps the gain once per frame,
   * and a stepped gain on a sustained tone is a buzz at the frame rate. This
   * schedules on the audio clock instead, which is both smooth and cheaper
   * than the frame loop it replaces.
   */
  rampVolume(value: number, seconds = 0.08): this {
    const gain = this.audio.gain.gain;
    const now = this.context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(value, now + Math.max(seconds, 1 / 1000));
    return this;
  }

  /**
   * Subscribes to the graph's analysis taps and starts them at `hz`.
   *
   * The engine's analyser taps the **whole spatial mix**, so a per-object
   * visual driven from it would pulse to the sum of every source. A
   * `tap.meter` inside the graph measures that one voice, before the panner,
   * and costs nothing until something reads it.
   *
   * Returns an unsubscribe, which also stops the reporting.
   */
  onAnalysis(listener: Parameters<VoiceHandle['onAnalysis']>[0], hz = 20): () => void {
    const off = this.voice.onAnalysis(listener);
    this.readers.set(off, hz);
    this.voice.setAnalysisInterval(this.fastestReader());
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.readers.delete(off);
      // The fastest *remaining* reader, not zero. Reporting is one rate for
      // the whole voice, so an unsubscribe that set it to zero would stop
      // every other reader.
      this.voice.setAnalysisInterval(this.fastestReader());
      off();
    };
  }

  private readonly readers = new Map<() => void, number>();

  private fastestReader(): number {
    let fastest = 0;
    for (const hz of this.readers.values()) if (hz > fastest) fastest = hz;
    return fastest;
  }

  /**
   * Stops the voice and releases the worklet.
   *
   * An AudioWorkletNode runs its `process` callback for as long as it is
   * connected. A decoration that does not dispose leaves a fused ASL graph
   * evaluating at 48 kHz after the object is gone.
   */
  dispose(): void {
    // Idempotent, because teardown gets called from more than one direction:
    // a distance pool releasing a voice, an object being unmounted, a host
    // shutting down. Two of those arriving for the same voice must not be an
    // error.
    if (this.disposed) return;
    this.disposed = true;

    const attempt = (what: () => void) => {
      try {
        what();
      } catch {
        // Every step here is best-effort. A context torn down under us, or a
        // node already detached, is not something a caller can act on, and
        // throwing out of teardown is how one dead object takes a host's
        // whole cleanup pass with it.
      }
    };

    if (this.strikeTimer !== undefined) {
      clearTimeout(this.strikeTimer);
      this.strikeTimer = undefined;
    }
    attempt(() => this.voice.noteOff());
    attempt(() => this.voice.driver?.stop());

    // Order matters and this is the expensive lesson in this file.
    //
    // `THREE.Audio.disconnect()` is a **targeted** disconnect:
    // `source.disconnect(getOutput())`, one specific edge. Web Audio throws
    // `InvalidAccessError` if that edge is already gone. Calling the
    // worklet's blanket `node.disconnect()` first removes every edge it has,
    // including that one, so three.js then throws trying to remove it again.
    //
    // So: let three.js take its own edge down first, then sweep whatever is
    // left. Both are still guarded, because a host may legitimately have
    // rearranged the graph underneath us.
    attempt(() => this.audio.disconnect());
    attempt(() => this.voice.node.disconnect());
  }

  private disposed = false;
}

/**
 * Builds a three.js audio object whose source is a crate graph.
 *
 * `three` is passed in rather than imported: see `ThreeNamespaceLike`. It
 * defaults to `globalThis.THREE`, which is what an XR Publisher plugin
 * actually has.
 */
export async function createCrateAudio(
  listener: ThreeListenerLike,
  graph: ASLGraphDescriptor | AudioMaterial,
  options: CrateAudioOptions = {},
  three: ThreeNamespaceLike = (globalThis as unknown as { THREE: ThreeNamespaceLike }).THREE,
): Promise<CrateAudio> {
  if (!three?.Audio) {
    throw new Error('crate-xr: no THREE namespace. Pass one, or load this inside XR Publisher.');
  }
  const context = listener.context;
  // `instanceof` rather than a duck-typed `'graph' in x`: a bare descriptor
  // that happened to carry a `graph` key would take the wrong branch, and the
  // symptom would be a voice compiled from the wrong object.
  const material = graph instanceof AudioMaterial ? graph : null;
  const descriptor: ASLGraphDescriptor = graph instanceof AudioMaterial ? graph.graph : graph;
  const voice = await rendererFor(context, options.workletUrl).createVoice(descriptor);

  // Before connecting, so the first block is already right. See the note on
  // `CrateAudioOptions.params`.
  //
  // An AudioMaterial's own values first, then the caller's overrides. Passing a
  // AudioMaterial and getting its declared defaults ignored would be a quiet
  // trap: the parameter schema is the AudioMaterial's whole public surface, and a
  // graph built from it starts at whatever `param.range` said `default` was.
  const settings = { ...material?.snapshotParams(), ...options.params };
  for (const name in settings) voice.setParam(name, settings[name]!);

  const audio = options.positional === false
    ? new three.Audio(listener)
    : new three.PositionalAudio(listener);
  audio.setNodeSource(voice.node);
  audio.setVolume(options.volume ?? 1);

  // Only a PositionalAudio has these; a plain Audio has no panner and the
  // optional calls are simply absent.
  if (audio.setRefDistance) {
    const spatial = options.spatial ?? {};
    audio.setRefDistance(spatial.refDistance ?? 6);
    audio.setRolloffFactor?.(spatial.rolloffFactor ?? 1.2);
    audio.setMaxDistance?.(spatial.maxDistance ?? 60);
    audio.setDistanceModel?.(spatial.distanceModel ?? 'inverse');
  }

  attachNodeToHtmlSink(listener.gain, context.destination);

  return new CrateAudio(audio, voice, context);
}
