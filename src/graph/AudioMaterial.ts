import { ASLValue } from '../asl/ASLValue';
import { createTrackedInputProxy, type ASLGraphDescriptor } from '../asl/graph';
import type { ASLNode } from '../asl/types';
import { audio, paramNode } from '../asl/builders';
import { audioPortNames, auxAudioPorts } from '../asl/ports';
import { AudioMaterialNotBoundError } from '../errors';
import type { VoiceHandle } from '../renderers/WebAudioRenderer';
import { connectSplitVoices } from '../renderers/splitVoices';
import { VoicePool, type VoiceBackend } from '../voices/VoicePool';
import type { VoiceSnapshot, VoiceStealingPolicy } from '../voices/allocate';
import { enumValue, formatParam, isSmoothedParam, quantizeParam, type ParamDescriptor } from './param';

/**
 * The object an AudioMaterial's `graph` builder receives. Arbitrary names
 * (`note`, `velocity`, `input`, ...) resolve lazily to a plain param node,
 * exactly like `ASL.node`'s own input proxy; `params` is
 * the one reserved key, pre-populated with one node per declared param so
 * every declared param exists in the graph whether or not the author reads
 * it, which matters once automation/AUParameterTree mapping is real.
 */
export type AudioMaterialGraphContext = Record<string, ASLValue> & {
  params: Record<string, ASLValue>;
  /**
   * Live audio inputs (`asl/ports.ts`). `ctx.input` is `audio.input()`, the
   * main insert signal, and reading it is all most effects need. `ctx.audio`
   * is how a graph names a second one (`audio.sidechain()`) or a fixed side
   * of a stereo pair (`audio.left()`, `audio.right()`).
   */
  audio: typeof audio;
};

export type AudioMaterialGraphBuilder = (ctx: AudioMaterialGraphContext) => ASLValue;

export type { VoiceStealingPolicy, VoiceSnapshot } from '../voices/allocate';

/**
 * How this AudioMaterial's output should land on another AudioMaterial's param jack.
 * Unipolar (envelopes, clocks, ramps): 0 is the param min, 1 is the max.
 * Bipolar (LFO, audio-rate osc): -1 is min, +1 is max. Audio into a param
 * jack is never mixed as audio; it is this mapping.
 */
export type CvPolarity = 'unipolar' | 'bipolar';

/**
 * Where an AudioMaterial's second audio input comes from. Declared on the AudioMaterial
 * and resolved by whoever builds the real graph (`ScenePlayback`), because a
 * AudioMaterial is authored long before it knows what scene it will live in, and
 * a track id is the only thing that survives being saved and reloaded.
 */
export type AudioSourceRef = { kind: 'track'; trackId: number } | { kind: 'master' };

export interface AudioMaterialOptions {
  name: string;
  /**
   * Registry key for the plugin that owns this AudioMaterial (`registry/`).
   * Defaults to `name`. Set it when the display name and the registered kind
   * should differ, e.g. two products sharing one implementation.
   */
  kind?: string;
  params?: Record<string, ParamDescriptor>;
  graph: AudioMaterialGraphBuilder;
  /** Param names (must already be keys of `params`) exposed to AutomationLane / a hosting DAW's parameter tree. */
  automatable?: readonly string[];
  polyphony?: number;
  voiceStealing?: VoiceStealingPolicy;
  /**
   * Output channels to evaluate. Left unset, an AudioMaterial that reads live
   * audio runs once per channel (a real stereo insert) and one that does not
   * runs once and is mirrored. Set `1` on an AudioMaterial whose output is a
   * control signal, where the second pass is cost with nothing to show for
   * it; set `2` to force it on.
   */
  channels?: 1 | 2;
  cvPolarity?: CvPolarity;
  /**
   * A split instrument's voice outputs (`ASLGraphDescriptor.sends`). Nodes
   * inside the graph the builder returns; the builder's output must be their
   * mix. Set by `flattenPatch` together with `bus`.
   */
  sends?: readonly ASLNode[];
  /**
   * What runs once on the sum of every voice: the summed modules of a patch
   * (`flattenPatch`, `voicing`). Its ports `send0`..`sendN` read the voices'
   * summed sends. Shares this material's parameter names.
   */
  bus?: AudioMaterial;
}

/**
 * An ASL graph, a parameter schema, and an inspector hint, bundled as one
 * unit. Different instruments are different graphs, not different classes.
 */
export class AudioMaterial {
  readonly name: string;
  /** Registry key for the plugin that created this AudioMaterial. See `registry/`. */
  readonly kind: string;
  readonly params: Readonly<Record<string, ParamDescriptor>>;
  readonly automatable: readonly string[];
  readonly polyphony: number;
  readonly voiceStealing?: VoiceStealingPolicy;
  readonly cvPolarity: CvPolarity;
  readonly graph: ASLGraphDescriptor;
  /** The summed half of a split instrument; see `AudioMaterialOptions.bus`. */
  readonly bus?: AudioMaterial;

  /**
   * Where this AudioMaterial came from in a hosted project: that project's own
   * track index (`HOSTED_MASTER_TRACK_INDEX` for the master bus) and plugin
   * slot index. Hosted automation lanes address params by exactly this pair
   * plus a param address, so without it a write has no way to find the live
   * voice this AudioMaterial is bound to: crate's own `track.id` and the dense
   * `materials` array index are both different numbers from the project's
   * sparse `pluginSlots` indices.
   */
  hostedSlot?: { trackIndex: number; slotIndex: number };

  /**
   * Decoded files this AudioMaterial's preset referenced, keyed by whatever the
   * owning plugin calls them (`graph/assets.ts`). Raw, caller-driven data,
   * never a live processor: a plugin's own live-bind code decides when and
   * how to push an asset into a renderer realm.
   *
   * Open-ended by design. Crate core cannot enumerate the file types a
   * third-party AudioMaterial might need, so it does not try.
   */
  private readonly assetMap = new Map<string, unknown>();

  private readonly audioSourceMap = new Map<string, AudioSourceRef>();
  private readonly paramValues: Record<string, number>;
  private readonly graphBuilder: AudioMaterialGraphBuilder;
  private readonly channelCount?: 1 | 2;
  private readonly sendNodes?: readonly ASLNode[];
  private pool: VoicePool | null = null;
  /** The bus a split instrument's voices sum into, while bound. */
  private busVoice: VoiceHandle | null = null;

  constructor(options: AudioMaterialOptions) {
    this.name = options.name;
    this.kind = options.kind ?? options.name;
    this.params = options.params ?? {};
    this.automatable = options.automatable ?? [];
    this.polyphony = options.polyphony ?? 1;
    if (this.polyphony < 1) {
      throw new RangeError(`AudioMaterial "${this.name}": polyphony must be >= 1`);
    }
    this.voiceStealing = options.voiceStealing ?? 'oldest';
    this.cvPolarity = options.cvPolarity ?? 'bipolar';

    for (const key of this.automatable) {
      if (!(key in this.params)) {
        throw new RangeError(`AudioMaterial "${this.name}": automatable references unknown param "${key}"`);
      }
    }

    this.paramValues = Object.fromEntries(Object.entries(this.params).map(([key, descriptor]) => [key, descriptor.default]));
    this.graphBuilder = options.graph;
    this.channelCount = options.channels;
    this.sendNodes = options.sends;
    this.bus = options.bus;

    const paramNodes: Record<string, ASLValue> = Object.fromEntries(
      Object.keys(this.params).map((key) => [key, paramNode(key)]),
    );
    const { proxy } = createTrackedInputProxy({ params: paramNodes, audio });
    const output = options.graph(proxy);
    if (!(output instanceof ASLValue)) {
      throw new TypeError(`AudioMaterial "${this.name}": graph builder must return an ASLValue.`);
    }
    const smooth = Object.keys(this.params).filter((key) => isSmoothedParam(this.params[key]!));
    this.graph = {
      inputs: Object.keys(this.params),
      output: output.node,
      channels: options.channels,
      ...(smooth.length > 0 ? { smooth } : {}),
      ...(options.sends && options.sends.length > 0 ? { sends: options.sends } : {}),
      ...(options.bus ? { bus: options.bus.graph } : {}),
    };
  }

  /**
   * Live audio inputs this AudioMaterial's graph reads, sorted, `input` included
   * when it reads one. A host wiring a sidechain needs this to know the
   * AudioMaterial wants one at all; the renderer turns it into worklet input
   * indices (`WebAudioRenderer.createVoice`).
   */
  get audioInputs(): readonly string[] {
    return audioPortNames(this.graph);
  }

  /** Inputs beyond the main one, in renderer input-index order (index + 1). */
  get auxAudioInputs(): readonly string[] {
    return auxAudioPorts(this.graph);
  }

  /**
   * Feeds one of this AudioMaterial's aux inputs from somewhere else in the
   * scene: `setAudioSource('sidechain', { kind: 'track', trackId })`. Pass
   * null to clear it, which leaves the port reading 0.
   *
   * Rejects a port the graph does not read, because the failure otherwise is
   * a compressor that simply never moves and no message anywhere saying why.
   */
  setAudioSource(port: string, source: AudioSourceRef | null): void {
    if (!this.auxAudioInputs.includes(port)) {
      throw new RangeError(
        `AudioMaterial "${this.name}" has no audio input "${port}" (has: ${
          this.auxAudioInputs.join(', ') || 'none besides input'
        })`,
      );
    }
    if (source) this.audioSourceMap.set(port, source);
    else this.audioSourceMap.delete(port);
  }

  /** Aux inputs a host has pointed at something, port name to source. */
  get audioSources(): ReadonlyMap<string, AudioSourceRef> {
    return this.audioSourceMap;
  }

  /** Stores a decoded asset under a plugin-chosen key. See `graph/assets.ts`. */
  setAsset(key: string, value: unknown): void {
    this.assetMap.set(key, value);
  }

  /**
   * Reads a decoded asset. The cast is the caller's: only the plugin that
   * wrote the key knows what shape it put there, which is the price of an
   * open registry and a fair one.
   */
  getAsset<T>(key: string): T | undefined {
    return this.assetMap.get(key) as T | undefined;
  }

  hasAsset(key: string): boolean {
    return this.assetMap.has(key);
  }

  clearAsset(key: string): boolean {
    return this.assetMap.delete(key);
  }

  get assetKeys(): readonly string[] {
    return [...this.assetMap.keys()];
  }

  getParam(name: string): number {
    if (!(name in this.params)) {
      throw new RangeError(`AudioMaterial "${this.name}" has no param "${name}"`);
    }
    return this.paramValues[name]!;
  }

  /**
   * Out of range throws; off the grid snaps. A value outside the declared
   * bounds is a caller bug. Silently clamping it hides the bug. A value
   * between two steps is what an automation lane and a fader drag both
   * produce, so the descriptor quantizes rather than asking every caller to.
   */
  setParam(name: string, value: number): void {
    const descriptor = this.params[name];
    if (!descriptor) {
      throw new RangeError(`AudioMaterial "${this.name}" has no param "${name}"`);
    }
    if (value < descriptor.min || value > descriptor.max) {
      throw new RangeError(
        `AudioMaterial "${this.name}".${name} must be within [${descriptor.min}, ${descriptor.max}], got ${value}`,
      );
    }
    const settled = quantizeParam(descriptor, value);
    this.paramValues[name] = settled;
    this.pool?.setParam(name, settled);
    this.busVoice?.setParam(name, settled);
  }

  /** Sets a named option on an `enum` param. Throws on any other kind. */
  setOption(name: string, option: string): void {
    const descriptor = this.params[name];
    if (!descriptor) {
      throw new RangeError(`AudioMaterial "${this.name}" has no param "${name}"`);
    }
    if (descriptor.kind !== 'enum') {
      throw new TypeError(`AudioMaterial "${this.name}".${name} is a ${descriptor.kind} param, not an enum`);
    }
    this.setParam(name, enumValue(descriptor, option));
  }

  /** The current value of an `enum` param as its option name. */
  getOption(name: string): string {
    const descriptor = this.params[name];
    if (!descriptor) {
      throw new RangeError(`AudioMaterial "${this.name}" has no param "${name}"`);
    }
    if (descriptor.kind !== 'enum') {
      throw new TypeError(`AudioMaterial "${this.name}".${name} is a ${descriptor.kind} param, not an enum`);
    }
    return descriptor.options[Math.round(this.paramValues[name]!)] ?? '';
  }

  /** What a control panel shows beside the fader. See `formatParam`. */
  formatParam(name: string): string {
    const descriptor = this.params[name];
    if (!descriptor) {
      throw new RangeError(`AudioMaterial "${this.name}" has no param "${name}"`);
    }
    return formatParam(descriptor, this.paramValues[name]!);
  }

  /**
   * Pre-allocates `polyphony` renderer voices and connects them to
   * `destination` when given. Tests can pass fake backends via
   * `attachVoices` instead.
   *
   * `seed` makes the pool reproducible: voice `i` is seeded `seed + i`, so
   * the voices stay independent of each other and identical across runs.
   * Omitted, the renderer picks (a fresh random seed per voice, live).
   */
  async bind(
    renderer: {
      createVoice: (
        graph: ASLGraphDescriptor,
        options?: { seed?: number; params?: Record<string, number>; sends?: boolean },
      ) => Promise<VoiceHandle>;
    },
    destination?: AudioNode,
    options: { seed?: number } = {},
  ): Promise<void> {
    this.unbind();
    const voices: VoiceHandle[] = [];
    // The current values travel with each voice, so none renders a block
    // with its parameters unset before the first note brings them.
    const params = this.snapshotParams();
    // A split instrument's voices hand their sends to one bus voice, which
    // is what reaches the destination; see `flattenPatch`'s `voicing`.
    const split = this.graph.bus && this.graph.sends ? this.graph.sends.length : 0;
    for (let i = 0; i < this.polyphony; i++) {
      const handle = await renderer.createVoice(this.graph, {
        params,
        ...(options.seed === undefined ? {} : { seed: options.seed + i }),
        ...(split > 0 ? { sends: true } : {}),
      });
      if (destination && split === 0) handle.node.connect(destination);
      voices.push(handle);
    }
    if (split > 0) {
      // Seeded like voice 0, as a one-voice host seeds the bus it carries.
      const bus = await renderer.createVoice(this.graph.bus!, {
        params,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
      });
      // An effect on the voices' sum: its gate opens once and stays open.
      bus.noteOn(params);
      connectSplitVoices(voices, bus, split);
      if (destination) bus.node.connect(destination);
      this.busVoice = bus;
    }
    this.pool = new VoicePool(this, voices, this.voiceStealing ?? 'oldest');
  }

  attachVoices(voices: VoiceBackend[]): void {
    this.unbind();
    this.pool = new VoicePool(this, voices, this.voiceStealing ?? 'oldest');
  }

  unbind(): void {
    this.pool?.allNotesOff();
    this.pool = null;
    this.busVoice = null;
  }

  get isBound(): boolean {
    return this.pool !== null;
  }

  /** MIDI note number. */
  noteOn(note: number, options?: { velocity?: number } & Record<string, number>): void {
    if (!this.pool) throw new AudioMaterialNotBoundError(this.name);
    this.pool.noteOn(note, options);
  }

  noteOff(note: number): void {
    if (!this.pool) throw new AudioMaterialNotBoundError(this.name);
    this.pool.noteOff(note);
  }

  allNotesOff(): void {
    this.pool?.allNotesOff();
  }

  get voices(): readonly VoiceSnapshot[] {
    return this.pool?.snapshots() ?? [];
  }

  /** Current param values, suitable for merging into a `VoiceHandle.noteOn(...)` call. */
  snapshotParams(): Record<string, number> {
    return { ...this.paramValues };
  }

  /**
   * A new AudioMaterial of the same type at the same param values. Two editor
   * nodes cannot share one instance: `bind()` tears the previous voice down.
   */
  duplicate(): AudioMaterial {
    const copy = new AudioMaterial({
      name: this.name,
      kind: this.kind,
      params: this.params,
      automatable: this.automatable,
      polyphony: this.polyphony,
      voiceStealing: this.voiceStealing,
      graph: this.graphBuilder,
      channels: this.channelCount,
      cvPolarity: this.cvPolarity,
      sends: this.sendNodes,
      bus: this.bus?.duplicate(),
    });
    for (const [name, value] of Object.entries(this.snapshotParams())) {
      copy.setParam(name, value);
    }
    return copy;
  }
}

/**
 * An ordered insert chain. Order is the signal order.
 */
export class AudioMaterialChain {
  private readonly items: AudioMaterial[] = [];

  add(material: AudioMaterial): void {
    this.items.push(material);
  }

  remove(material: AudioMaterial): boolean {
    const index = this.items.indexOf(material);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  get list(): readonly AudioMaterial[] {
    return this.items;
  }

  [Symbol.iterator](): Iterator<AudioMaterial> {
    return this.items[Symbol.iterator]();
  }
}
