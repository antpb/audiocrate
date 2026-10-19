import type { TransportAnchor } from '../asl/transportNodes';
import type { ASLGraphDescriptor } from '../asl/graph';
import { auxAudioPorts } from '../asl/ports';
import type { MeterReading } from '../asl/analysis';
import { crateWorkletUrls } from './worklet/workletUrls';

export interface VoiceHandle {
  /** The underlying AudioWorkletNode; connect it into a graph like any other node. */
  readonly node: AudioWorkletNode;
  /**
   * Live audio inputs beyond the main one, in worklet input-index order.
   * A graph that reads `audio.sidechain()` gets a second real input on the
   * node, and this is how a host finds it.
   */
  readonly auxInputs: readonly string[];
  /**
   * Worklet input index for a named port, for `source.connect(voice.node, 0,
   * voice.inputIndexFor('sidechain'))`. Throws for a port this graph does not
   * read, rather than silently connecting to input 0 and sounding like a
   * sidechain that does nothing.
   */
  inputIndexFor(name: string): number;
  /**
   * Silent ConstantSource feeding the worklet input. Safari will not pull an
   * AudioWorkletNode that advertises an input and has nothing connected, and
   * it may also skip a 0-input worklet. The reference is kept on the handle
   * so GC cannot collect the driver mid-play.
   */
  readonly driver?: ConstantSourceNode;
  noteOn(params: Record<string, number>): void;
  noteOff(): void;
  /** Updates one param on the already-running voice, e.g. an inspector slider moved mid-note. */
  setParam(name: string, value: number): void;
  /**
   * Creates the DSP bound to a kernel slot the AudioMaterial's graph names
   * (`renderers/kernel.ts`). `payload` is whatever that kernel's factory
   * expects, and it has to carry everything the kernel needs, because the
   * worklet realm cannot fetch or import anything for itself: a WASM binary
   * read on the main thread, a model's JSON, a sample rate hint.
   *
   * Resolves when the kernel reports ready, rejects if this worklet build has
   * no factory for that slot. That rejection is the useful one: it means the
   * host bundled crate's plain worklet and then asked for an engine that is
   * not in it.
   */
  loadKernel(slot: string, payload: unknown): Promise<void>;
  /**
   * Sends a slot-specific message to an already-loaded kernel: an impulse
   * response, a loop buffer, anything that is not a numeric param. Messages
   * for a kernel that has not finished loading are queued by the worklet, so
   * a host may post them in the same turn as `loadKernel`.
   */
  sendKernel(slot: string, message: unknown): void;
  midiNoteOn(note: number, velocity: number, when?: number): void;
  midiNoteOff(note: number, when?: number): void;
  midiControlChange(cc: number, value: number, when?: number): void;
  allNotesOff(): void;
  setHostBpm(bpm: number): void;
  /**
   * Publishes the host's musical position, so a graph's `transport` nodes
   * (`asl/transportNodes.ts`) know where the song is.
   *
   * An **anchor**, not a stream: a position pinned to a moment on the audio
   * clock. The worklet derives every block's position from its own
   * `currentTime`, so this costs one message per transport change rather than
   * one per block, and the two realms cannot drift apart because they are
   * reading the same clock. Post it on play, pause, seek and tempo change.
   */
  setTransport(anchor: TransportAnchor): void;
  /**
   * How often this voice should report its taps (`asl/analysis.ts`), in Hz.
   * **Zero, the default, means never**: a tap costs nothing until a host asks
   * for it, and a UI that stops looking should say so rather than leave the
   * audio thread posting into nothing.
   *
   * A display rate, not an audio rate. 30 is smooth; there is no reason to
   * exceed a screen's refresh.
   */
  setAnalysisInterval(hz: number): void;
  /**
   * Subscribes to analysis frames. Returns an unsubscribe. Does not start
   * them: call `setAnalysisInterval` too, which is deliberately separate so
   * several readers can share one voice's stream without fighting over its
   * rate.
   */
  onAnalysis(listener: (frame: AnalysisMessage) => void): () => void;
}

/** One analysis frame as it arrives on the main thread. */
export interface AnalysisMessage {
  /** The audio clock when the frame was drained, in `AudioContext` seconds. */
  time: number;
  meters: Record<string, MeterReading>;
  /** Oldest-sample-first windows, ready for `fftMagnitude` / `yinPitch` / `momentaryLufs`. */
  captures: Record<string, Float32Array>;
  /** Whatever bound kernels reported from `poll()`, keyed by slot. */
  kernels?: Record<string, unknown>;
}

export interface WebAudioRendererOptions {
  /**
   * The worklet module to load. Defaults to crate's own (ASL only, no
   * kernels). A host that needs kernels bundles its own entry built with
   * `defineCrateVoiceProcessor` and passes its URL here.
   *
   * **A list means "try these in order".** `audioWorklet.addModule` is one of
   * the less uniform corners of Web Audio: engines disagree about which URL
   * schemes a worklet module may be fetched from, and a host that has to
   * deliver the module as data rather than as a file (a single-file plugin,
   * an extension) cannot know in advance which scheme the browser in front of
   * it will accept. Passing every option it has is better than guessing,
   * because the guess fails as an opaque rejection at the first note.
   */
  workletUrl?: string | readonly string[];
  /** Processor name registered by that module. Defaults to `crate-voice-processor`. */
  processorName?: string;
}

interface SharedWorkletLoad {
  /** Resolves to the URL that loaded. */
  readonly promise: Promise<string>;
  readonly explicitUrl: string | null;
}

const WORKLET_LOADS_KEY = Symbol.for('audiocrate.workletLoads');

/** The per-context ledger of worklet loads, or undefined if the context will not hold one. */
function sharedLoads(context: AudioContext): Map<string, SharedWorkletLoad> | undefined {
  const holder = context as unknown as Record<symbol, Map<string, SharedWorkletLoad> | undefined>;
  let loads = holder[WORKLET_LOADS_KEY];
  if (!loads) {
    loads = new Map();
    try {
      Object.defineProperty(holder, WORKLET_LOADS_KEY, { value: loads, configurable: true });
    } catch {
      // A frozen or proxied context: fall back to loading per renderer.
      return undefined;
    }
  }
  return loads;
}

/**
 * Fuses an ASL graph into one AudioWorkletProcessor
 * (worklet/defineVoiceProcessor.ts). One worklet per voice. `AudioMaterial.bind`
 * calls `createVoice` once per `polyphony` slot.
 *
 * Not covered by vitest: AudioWorkletNode/AudioContext do not exist in Node.
 */
export class WebAudioRenderer {
  private modulePromise: Promise<void> | null = null;
  private readonly workletUrls: readonly string[];
  private readonly processorName: string;
  /** The host's own worklet URL(s), or null for crate's bundled worklet. */
  private readonly explicitUrl: string | null;
  /** Which URL actually loaded, for a host that wants to report it. */
  loadedWorkletUrl: string | null = null;

  constructor(
    private readonly context: AudioContext,
    options: WebAudioRendererOptions = {},
  ) {
    // `crateWorkletUrls()` is called only when the host did not supply a URL,
    // because minting a blob costs a copy of the worklet source and a host
    // that serves its own asset should not pay for one it will not use.
    const url = options.workletUrl;
    this.explicitUrl = url === undefined ? null : (Array.isArray(url) ? url : [url]).join(' | ');
    this.workletUrls =
      url === undefined
        ? crateWorkletUrls()
        : ((Array.isArray(url) ? url : [url]) as readonly string[]);
    if (this.workletUrls.length === 0) {
      // Only reachable when every scheme in `crateWorkletUrls` threw, which
      // in practice means a Content-Security-Policy that forbids blob: and
      // data: alike. Saying so here is worth a great deal, because the
      // alternative is `addModule` rejecting with nothing that names CSP.
      throw new Error(
        'crate: no worklet URL could be created. Blob and data URLs both failed, ' +
          'which usually means a Content-Security-Policy blocks them. Serve ' +
          "crate's dist/crate-voice-processor.js yourself and pass its URL as " +
          '`workletUrl`.',
      );
    }
    this.processorName = options.processorName ?? 'crate-voice-processor';
  }

  /**
   * Loads the worklet module without creating a voice.
   *
   * `createVoice` does this for you. It is public because the module carries
   * more than voices: `crate-foa-encoder` is registered by the same bundle,
   * and a host that wants a spatial source before it wants an instrument
   * would otherwise have to create a throwaway voice to get the processor
   * registered. Idempotent, and safe to await repeatedly.
   */
  ensureWorkletLoaded(): Promise<void> {
    return this.ensureModuleLoaded();
  }

  private ensureModuleLoaded(): Promise<void> {
    if (!this.modulePromise) {
      this.modulePromise = this.loadShared();
    }
    return this.modulePromise;
  }

  /**
   * One `addModule` per context per processor name, however many renderers
   * (or copies of audiocrate) ask. Each load recompiles about 140 kB of
   * worklet on the audio thread, and every load after the first registers
   * nothing (see `registerOnce.ts`), so a second one is pure cost.
   *
   * The ledger lives on the context under `Symbol.for`, which every copy of
   * the package in the page resolves to the same key. A load that fails is
   * forgotten, so the next renderer tries again rather than inheriting it.
   */
  private async loadShared(): Promise<void> {
    const loads = sharedLoads(this.context);
    const existing = loads?.get(this.processorName);
    if (existing) {
      if (this.explicitUrl !== null && existing.explicitUrl !== this.explicitUrl) {
        console.warn(
          `audiocrate: "${this.processorName}" is already loaded on this AudioContext from ` +
            `${existing.explicitUrl ?? "audiocrate's bundled worklet"}; ${this.explicitUrl} ` +
            'will not be loaded. Pass a distinct processorName to run a second worklet build.',
        );
      }
      this.loadedWorkletUrl = await existing.promise;
      return;
    }
    const promise = this.loadModule().then(() => this.loadedWorkletUrl as string);
    const entry: SharedWorkletLoad = { promise, explicitUrl: this.explicitUrl };
    loads?.set(this.processorName, entry);
    try {
      await promise;
    } catch (error) {
      if (loads?.get(this.processorName) === entry) loads.delete(this.processorName);
      // Also forget it here, so this renderer's own next voice retries.
      this.modulePromise = null;
      throw error;
    }
  }

  /**
   * Tries each candidate URL until one loads.
   *
   * Every failure is kept and reported together. A host that gets here has a
   * page with no audio and needs to know what each attempt actually said,
   * because "addModule failed" on its own has sent more than one person
   * looking at their DSP.
   */
  private async loadModule(): Promise<void> {
    if (!this.context.audioWorklet) {
      // Undefined rather than throwing, and the reason is almost always the
      // same one: AudioWorklet is exposed only in a secure context, so a page
      // served over plain http has no `audioWorklet` at all.
      throw new Error(
        'crate: this AudioContext has no audioWorklet. AudioWorklet requires a secure context (https or localhost).',
      );
    }
    const failures: string[] = [];
    for (const url of this.workletUrls) {
      try {
        await this.context.audioWorklet.addModule(url);
        this.loadedWorkletUrl = url;
        return;
      } catch (error) {
        const scheme = url.slice(0, url.indexOf(':') + 1) || url;
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        failures.push(`${scheme || 'url'} ${reason}`);
      }
    }
    throw new Error(
      `crate: no worklet URL was accepted (${this.workletUrls.length} tried).\n  ` +
        failures.join('\n  '),
    );
  }

  /**
   * `seed` fixes the voice's `noise` and `random` streams (`asl/rng.ts`), so
   * a world generated from a seed can sound the same on every visit and every
   * device. Omitted, each voice gets a fresh random seed, which keeps two
   * voices of one graph (rain cells, a polyphonic pool) from playing the same
   * noise in lockstep.
   *
   * `params` are the values the voice starts with. Pass them here rather than
   * with `setParam` afterwards whenever they are known: a message arrives
   * after the node exists, and a busy main thread lets the processor render
   * first with every parameter at zero.
   */
  async createVoice(
    graph: ASLGraphDescriptor,
    options: {
      seed?: number;
      params?: Record<string, number>;
      /**
       * A split instrument's voice alone: one stereo output per send, for a
       * host that sums its voices into one bus node (`connectSplitVoices`).
       * Off, a split graph renders its own bus inside the voice.
       */
      sends?: boolean;
    } = {},
  ): Promise<VoiceHandle> {
    await this.ensureModuleLoaded();
    // Input 0 is always the main signal; the graph's other named ports get
    // one input each, in the same sorted order the processor derives from
    // the same graph (asl/ports.ts). Nothing is passed across to say so, on
    // purpose: two copies of that list could disagree.
    const auxInputs = auxAudioPorts(graph);
    const sendOutputs = options.sends && graph.sends ? graph.sends.length : 1;
    const node = new AudioWorkletNode(this.context, this.processorName, {
      // Always at least 1 input + a silent driver. Safari skips process() for
      // a 0-input worklet and also for a 1-input worklet with nothing wired.
      numberOfInputs: 1 + auxInputs.length,
      numberOfOutputs: sendOutputs,
      outputChannelCount: new Array(sendOutputs).fill(2),
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: {
        graph,
        seed: options.seed ?? Math.floor(Math.random() * 4294967296),
        ...(options.params ? { params: options.params } : {}),
        ...(options.sends && graph.sends ? { sends: true } : {}),
      },
    });
    const driver = this.context.createConstantSource();
    driver.offset.value = 0;
    driver.connect(node);
    driver.start();
    // addEventListener does not start the port. Without this, ready
    // messages never arrive and play waits forever.
    node.port.start();

    const waitForKernel = (slot: string, ms = 8000) =>
      new Promise<void>((resolve, reject) => {
        const finish = (fn: () => void) => {
          clearTimeout(timer);
          node.port.removeEventListener('message', onMessage);
          fn();
        };
        const onMessage = (event: MessageEvent<{ type?: string; slot?: string; message?: string }>) => {
          if (event.data?.slot !== slot) return;
          if (event.data.type === 'kernelReady') finish(() => resolve());
          else if (event.data.type === 'kernelError') {
            finish(() => reject(new Error(event.data.message ?? `kernel "${slot}" failed`)));
          }
        };
        const timer = setTimeout(() => {
          finish(() => reject(new Error(`kernel "${slot}" load timed out`)));
        }, ms);
        node.port.addEventListener('message', onMessage);
      });

    return {
      node,
      driver,
      auxInputs,
      inputIndexFor: (name: string) => {
        if (name === 'input') return 0;
        const index = auxInputs.indexOf(name);
        if (index === -1) {
          throw new RangeError(
            `voice has no audio input "${name}" (has: ${['input', ...auxInputs].join(', ')})`,
          );
        }
        return index + 1;
      },
      noteOn: (params: Record<string, number>) => node.port.postMessage({ type: 'noteOn', params }),
      noteOff: () => node.port.postMessage({ type: 'noteOff' }),
      setParam: (name: string, value: number) => node.port.postMessage({ type: 'setParam', name, value }),
      loadKernel: (slot: string, payload: unknown) => {
        const ready = waitForKernel(slot);
        node.port.postMessage({ type: 'loadKernel', slot, payload });
        return ready;
      },
      sendKernel: (slot: string, message: unknown) =>
        node.port.postMessage({ type: 'kernelMessage', slot, message }),
      midiNoteOn: (note: number, velocity: number, when?: number) =>
        node.port.postMessage({ type: 'midiNoteOn', note, velocity, when }),
      midiNoteOff: (note: number, when?: number) => node.port.postMessage({ type: 'midiNoteOff', note, when }),
      midiControlChange: (cc: number, value: number, when?: number) =>
        node.port.postMessage({ type: 'midiControlChange', cc, value, when }),
      allNotesOff: () => node.port.postMessage({ type: 'allNotesOff' }),
      setHostBpm: (bpm: number) => node.port.postMessage({ type: 'setHostBpm', bpm }),
      setTransport: (anchor: TransportAnchor) => node.port.postMessage({ type: 'setTransport', anchor }),
      setAnalysisInterval: (hz: number) => node.port.postMessage({ type: 'setAnalysisInterval', hz }),
      onAnalysis: (listener: (frame: AnalysisMessage) => void) => {
        const onMessage = (event: MessageEvent<{ type?: string } & AnalysisMessage>) => {
          if (event.data?.type === 'analysis') listener(event.data);
        };
        node.port.addEventListener('message', onMessage);
        return () => node.port.removeEventListener('message', onMessage);
      },
    };
  }
}

