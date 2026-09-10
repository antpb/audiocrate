/**
 * The audio-thread half of `WebAudioRenderer`, factored so a host can build
 * its own worklet bundle with its own kernels in it.
 *
 * An AudioWorklet runs in an isolated global with no `window`, no `fetch`,
 * no dynamic `import()`, and no shared module cache with the main thread.
 * That is not a crate limitation, it is the platform, and it has one
 * architectural consequence: **the set of kernels a
 * worklet can run is fixed when that worklet is bundled.** There is no way
 * to hand a running worklet new DSP code.
 *
 * So crate does not ship one worklet with every engine compiled into it.
 * It ships this factory. Audiocrate's own worklet
 * (`crate-voice-processor.ts`) passes no kernels at all: pure ASL. A host
 * that wants neural amp inference, or a granular engine, or its own
 * proprietary DSP, writes a four-line worklet entry that imports its kernel
 * factories, calls `defineCrateVoiceProcessor`, and points its bundler at
 * that file instead. Nothing in crate has to know the kernel exists.
 *
 * Everything else here (param messages, MIDI scheduling with sample-accurate
 * sub-block splitting, channel fan-out) is generic and shared.
 */
import { compileVoice, type PortBlocks, type VoiceRuntimeState, type CompiledVoice } from '../../asl/compile';
import type { ASLGraphDescriptor } from '../../asl/graph';
import { auxAudioPorts } from '../../asl/ports';
import {
  DEFAULT_TRANSPORT_ANCHOR,
  advanceTransport,
  transportAt,
  type TransportAnchor,
  type TransportSnapshot,
} from '../../asl/transportNodes';
import type { KernelFactoryMap, KernelProcessor } from '../kernel';
import { IR_KERNEL_SLOT, irKernelFactory } from '../kernels/irKernel';
import { WASM_KERNEL_SLOT, isWasmKernelPayload, wasmKernelFactory } from '../kernels/wasmKernel';
import { defineCrateFoaEncoder } from '../../spatial/worklet/defineFoaEncoder';

/**
 * Kernels that belong in every crate worklet. IR is a primitive, not a
 * plugin. `wasm` is the portable kernel: not DSP of its own, but the loader
 * that lets a Material ship DSP this bundle was never built with.
 */
const CORE_KERNELS: KernelFactoryMap = {
  [IR_KERNEL_SLOT]: irKernelFactory,
  [WASM_KERNEL_SLOT]: wasmKernelFactory,
};

interface CrateVoiceProcessorOptions {
  graph: ASLGraphDescriptor;
}

export type PortMessage =
  | { type: 'noteOn'; params: Record<string, number> }
  | { type: 'noteOff' }
  | { type: 'setParam'; name: string; value: number }
  | { type: 'loadKernel'; slot: string; payload: unknown }
  | { type: 'kernelMessage'; slot: string; message: unknown }
  | { type: 'midiNoteOn'; note: number; velocity: number; when?: number }
  | { type: 'midiNoteOff'; note: number; when?: number }
  | { type: 'midiControlChange'; cc: number; value: number; when?: number }
  | { type: 'allNotesOff' }
  | { type: 'setHostBpm'; bpm: number }
  | { type: 'setTransport'; anchor: TransportAnchor }
  | { type: 'setAnalysisInterval'; hz: number };

/**
 * An event with a time. `enqueueMidi` applies anything untimed immediately,
 * so only these ever reach `scheduledMidi`, and saying that in the type is
 * what lets the sub-block split arithmetic read `when` without guarding.
 */
type TimedMidi = ScheduledMidi & { when: number };

type ScheduledMidi =
  | { when?: number; kind: 'on'; note: number; velocity: number }
  | { when?: number; kind: 'off'; note: number }
  | { when?: number; kind: 'cc'; cc: number; value: number }
  | { when?: number; kind: 'allOff' };

/**
 * Registers a crate voice processor under `processorName`, able to create the
 * kernels in `kernels` and no others. A `loadKernel` for an unknown slot is
 * answered with a `kernelError`, not a silent no-op, because a host that
 * built the wrong worklet should find out immediately rather than wonder why
 * its amp sounds clean.
 */
export function defineCrateVoiceProcessor(
  processorName: string,
  kernels: KernelFactoryMap = {},
): void {
  // Every crate worklet carries the spatial encoder. A host that adds kernels
  // writes its own entry calling this factory, and `SpatialBus` failing to
  // find `crate-foa-encoder` in that build would be a confusing way to learn
  // that spatial audio is a separate opt-in. Registering it here is
  // idempotent, so a host may also call `defineCrateFoaEncoder` itself.
  defineCrateFoaEncoder();
  const factories: KernelFactoryMap = { ...CORE_KERNELS, ...kernels };
  class CrateVoiceProcessor extends AudioWorkletProcessor {
    private readonly voice: CompiledVoice;
    private readonly state: VoiceRuntimeState;
    /**
     * Which named port each `inputs[k]` past the first carries, derived from
     * the graph rather than sent over, so this and `WebAudioRenderer` cannot
     * disagree about which input is the sidechain.
     */
    private readonly auxPorts: readonly string[];
    /**
     * Messages and notes that arrived before their kernel finished loading.
     * A host legitimately posts "load this impulse response" in the same turn
     * as "load this kernel", and WASM instantiation is async, so dropping
     * them would lose real state.
     */
    private readonly pendingMessages = new Map<string, unknown[]>();
    private pendingMidi: ScheduledMidi[] = [];
    private scheduledMidi: TimedMidi[] = [];
    private pendingHostBpm: number | null = null;
    /**
     * An anchor, not a stream. The host posts one when something changes and
     * this realm derives the position from its own audio clock, so the
     * musical position costs no messages per block and the two realms cannot
     * drift apart, for the same reason `transport.play()` captures one origin.
     */
    private transportAnchor: TransportAnchor = DEFAULT_TRANSPORT_ANCHOR;
    /**
     * How often to post an analysis frame, in Hz. Zero is off and is the
     * default: a tap in a graph nobody reads must cost nothing but its own
     * two operations, and metering every voice at block rate would be 375
     * messages a second each.
     */
    private analysisHz = 0;
    private nextAnalysisTime = 0;
    /**
     * Scratch reused by `process`, because `process` runs 375 times a second
     * per voice and a scene has one of these per Material slot. Two small
     * objects per block per voice is not much on its own; forty-nine voices
     * making them is a steady drip of garbage onto the one thread that must
     * never pause.
     */
    private readonly dueScratch: TimedMidi[] = [];
    private auxScratch: Record<string, readonly (Float32Array | undefined)[] | undefined> | undefined;

    constructor(options?: AudioWorkletNodeOptions) {
      super(options);
      const { graph } = (options?.processorOptions ?? {}) as CrateVoiceProcessorOptions;
      this.voice = compileVoice(graph);
      this.auxPorts = auxAudioPorts(graph);
      this.state = this.voice.createState();
      this.state.kernels = new Map();

      this.port.onmessage = (event: MessageEvent<PortMessage>) => {
        const msg = event.data;
        switch (msg.type) {
          case 'noteOn':
            this.voice.noteOn(this.state, msg.params);
            break;
          case 'noteOff':
            this.voice.noteOff(this.state);
            break;
          case 'setParam':
            this.state.params[msg.name] = msg.value;
            break;
          case 'loadKernel':
            this.loadKernel(msg.slot, msg.payload).catch((err) => {
              this.port.postMessage({ type: 'kernelError', slot: msg.slot, message: String(err) });
            });
            break;
          case 'kernelMessage': {
            const processor = this.state.kernels?.get(msg.slot);
            if (processor?.onMessage) {
              const reply = processor.onMessage(msg.message);
              if (reply !== undefined) {
                this.port.postMessage({ type: 'kernelReply', slot: msg.slot, reply });
              }
            } else {
              const queue = this.pendingMessages.get(msg.slot) ?? [];
              queue.push(msg.message);
              this.pendingMessages.set(msg.slot, queue);
            }
            break;
          }
          case 'midiNoteOn':
            this.enqueueMidi({ kind: 'on', note: msg.note, velocity: msg.velocity, when: msg.when });
            break;
          case 'midiNoteOff':
            this.enqueueMidi({ kind: 'off', note: msg.note, when: msg.when });
            break;
          case 'midiControlChange':
            this.enqueueMidi({ kind: 'cc', cc: msg.cc, value: msg.value, when: msg.when });
            break;
          case 'allNotesOff':
            this.scheduledMidi = [];
            this.applyMidi({ kind: 'allOff', when: 0 });
            break;
          case 'setTransport':
            this.transportAnchor = msg.anchor;
            // A kernel that tracks tempo should hear about it here too, so a
            // host does not have to send the same fact twice.
            if (msg.anchor.bpm !== this.pendingHostBpm) {
              this.pendingHostBpm = msg.anchor.bpm;
              this.eachKernel((k) => k.setHostBpm?.(msg.anchor.bpm));
            }
            break;

          case 'setHostBpm':
            this.pendingHostBpm = msg.bpm;
            this.eachKernel((k) => k.setHostBpm?.(msg.bpm));
            break;
          case 'setAnalysisInterval':
            this.analysisHz = Math.max(0, msg.hz);
            // Fire on the next block rather than a full interval later, so
            // turning a meter on looks immediate.
            this.nextAnalysisTime = 0;
            break;
        }
      };
    }

    private eachKernel(fn: (kernel: KernelProcessor) => void): void {
      const bound = this.state.kernels;
      if (!bound) return;
      for (const kernel of bound.values()) fn(kernel);
    }

    private hasKernels(): boolean {
      return (this.state.kernels?.size ?? 0) > 0;
    }

    private async loadKernel(slot: string, payload: unknown): Promise<void> {
      // A slot this build has no factory for is not automatically an error.
      // If the payload is a portable kernel (`kernels/wasmKernel.ts`) the
      // module itself is the DSP, and a Material can name its own slot
      // without anyone rebuilding this worklet. That fallback is the whole
      // point of the portable format.
      const factory = factories[slot] ?? (isWasmKernelPayload(payload) ? wasmKernelFactory : undefined);
      if (!factory) {
        throw new Error(
          `no kernel registered for slot "${slot}" in this worklet build, and the payload is not a portable WASM kernel (available: ${
            Object.keys(factories).join(', ') || 'none'
          })`,
        );
      }
      this.state.kernels?.get(slot)?.dispose?.();
      const processor = await factory(sampleRate, payload);
      this.state.kernels?.set(slot, processor);

      processor.applyParams?.(this.state.params);
      if (this.pendingHostBpm != null) processor.setHostBpm?.(this.pendingHostBpm);
      for (const message of this.pendingMessages.get(slot) ?? []) processor.onMessage?.(message);
      this.pendingMessages.delete(slot);
      // Notes that arrived before any kernel existed are replayed once, at
      // the first kernel that can take them. A held note posted during load
      // would otherwise never sound.
      const replay = this.pendingMidi;
      this.pendingMidi = [];
      for (const event of replay) this.applyMidi(event);

      this.port.postMessage({
        type: 'kernelReady',
        slot,
        latencySamples: processor.latencySamples?.() ?? 0,
        info: processor.describe?.(),
      });
    }

    private enqueueMidi(event: ScheduledMidi): void {
      if (event.when == null || event.when <= currentTime) {
        this.applyMidi(event);
        return;
      }
      const timed = event as TimedMidi;
      let i = this.scheduledMidi.length;
      while (i > 0 && this.scheduledMidi[i - 1]!.when > timed.when) i -= 1;
      this.scheduledMidi.splice(i, 0, timed);
    }

    private applyMidi(event: ScheduledMidi): void {
      if (!this.hasKernels()) {
        // Hold it: the kernel that would answer this has not loaded yet. A
        // note or a CC posted during WASM instantiation is real state, not
        // something to drop on the floor.
        this.pendingMidi.push(event);
        return;
      }
      if (event.kind === 'cc') {
        this.eachKernel((k) => k.controlChange?.(event.cc, event.value, this.state.params));
        return;
      }
      if (event.kind === 'on') this.eachKernel((k) => k.noteOn?.(event.note, event.velocity));
      else if (event.kind === 'off') this.eachKernel((k) => k.noteOff?.(event.note));
      else this.eachKernel((k) => k.allNotesOff?.());
    }

    private renderRange(
      channel0: Float32Array,
      inputChannel: Float32Array | undefined,
      inputRight: Float32Array | undefined,
      outputRight: Float32Array | undefined,
      aux: PortBlocks | undefined,
      start: number,
      end: number,
      transport: TransportSnapshot,
    ): boolean {
      if (end <= start) return false;
      let ports = aux;
      if (aux && start !== 0) {
        // Sub-block splitting for sample-accurate MIDI has to slice the aux
        // ports too, or a sidechain would be read from the top of the block
        // for every range after the first.
        const sliced: Record<string, readonly (Float32Array | undefined)[] | undefined> = {};
        for (const [name, channels] of Object.entries(aux)) {
          sliced[name] = channels?.map((channel) => channel?.subarray(start, end));
        }
        ports = sliced;
      }
      return this.voice.renderBlock(
        this.state,
        sampleRate,
        channel0.subarray(start, end),
        inputChannel?.subarray(start, end),
        {
          inputR: inputRight?.subarray(start, end),
          outputR: outputRight?.subarray(start, end),
          ports,
          // Advanced to where this sub-range actually starts. Sample-accurate
          // MIDI splits a block into ranges, and handing each of them the
          // block's own position would restart the musical clock at every
          // note, which is audible as a synced LFO stuttering under a busy
          // MIDI part.
          transport: advanceTransport(transport, start, sampleRate),
        },
      );
    }

    /**
     * Drains taps and kernel polls onto the port, at most `analysisHz` times
     * a second. Timed off the audio clock rather than a block counter so the
     * rate a host asks for is the rate it gets whatever the block size is.
     */
    private maybePostAnalysis(): void {
      if (this.analysisHz <= 0) return;
      if (currentTime < this.nextAnalysisTime) return;
      this.nextAnalysisTime = currentTime + 1 / this.analysisHz;

      const frame = this.voice.drainAnalysis(this.state);
      let kernels: Record<string, unknown> | undefined;
      const bound = this.state.kernels;
      if (bound) {
        for (const [slot, processor] of bound) {
          const reading = processor.poll?.();
          if (reading !== undefined) (kernels ??= {})[slot] = reading;
        }
      }
      if (!frame && !kernels) return;
      this.port.postMessage({
        type: 'analysis',
        time: currentTime,
        meters: frame?.meters ?? {},
        captures: frame?.captures ?? {},
        kernels,
      });
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const output = outputs[0];
      const channel0 = output?.[0];
      if (!channel0) return true;

      // An effect-style Material's graph reads its upstream signal through a
      // plain 'input' param node (same mechanism note/velocity use), so an
      // unconnected input (a synth Material has nothing feeding this node)
      // just leaves it at 0 rather than needing a special-cased signal path.
      const inputChannel = inputs[0]?.[0];
      const inputRight = inputs[0]?.[1];
      const hasInput = inputChannel !== undefined && inputChannel.length === channel0.length;
      const inL = hasInput ? inputChannel : undefined;
      const inR = hasInput ? inputRight : undefined;
      const outR = output[1];
      const frames = channel0.length;
      const blockEnd = currentTime + frames / sampleRate;

      // Inputs past the first are the graph's named ports, in the order both
      // realms derive from the graph. An unconnected one arrives as an empty
      // array and reads as 0, whether that is an absent key or a present one
      // holding nothing.
      let aux: Record<string, readonly (Float32Array | undefined)[] | undefined> | undefined;
      if (this.auxPorts.length > 0) {
        aux = this.auxScratch;
        if (!aux) {
          aux = {};
          for (const name of this.auxPorts) aux[name] = undefined;
          this.auxScratch = aux;
        }
        for (let k = 0; k < this.auxPorts.length; k++) {
          const channels = inputs[k + 1];
          aux[this.auxPorts[k]!] = channels && channels.length > 0 ? channels : undefined;
        }
      }

      // Split the block at each due MIDI event so a note lands on its sample,
      // not on the next 128-frame boundary.
      const due = this.dueScratch;
      due.length = 0;
      for (;;) {
        const next = this.scheduledMidi[0];
        if (!next || next.when >= blockEnd) break;
        due.push(this.scheduledMidi.shift()!);
      }
      // One derivation per block, from the audio clock. Every sub-range then
      // offsets from this, so the musical position is continuous across a
      // block however many times MIDI splits it.
      const transport = transportAt(this.transportAnchor, currentTime);

      let wroteRight = false;
      if (due.length === 0) {
        wroteRight = this.renderRange(channel0, inL, inR, outR, aux, 0, frames, transport);
      } else {
        let offset = 0;
        for (const event of due) {
          let sample = Math.round((event.when - currentTime) * sampleRate);
          if (sample < offset) sample = offset;
          if (sample > frames) sample = frames;
          wroteRight =
            this.renderRange(channel0, inL, inR, outR, aux, offset, sample, transport) || wroteRight;
          offset = sample;
          this.applyMidi(event);
        }
        wroteRight =
          this.renderRange(channel0, inL, inR, outR, aux, offset, frames, transport) || wroteRight;
      }

      this.maybePostAnalysis();

      // `renderBlock` says whether it filled the right channel: a bound
      // source kernel does, and so does a stereo ASL graph. Anything else,
      // including a graph with a seam kernel in it, is one mono pass, so
      // mirror channel 0 across the rest.
      if (!wroteRight) {
        for (let ch = 1; ch < output.length; ch++) {
          output[ch]?.set(channel0);
        }
      }
      return true;
    }
  }

  registerProcessor(processorName, CrateVoiceProcessor);
}
