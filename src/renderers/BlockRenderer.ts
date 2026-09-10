/**
 * Renders a graph block by block, holding its state between calls.
 *
 * ## Why this exists next to `OfflineRenderer`
 *
 * `OfflineRenderer.render` compiles a voice, renders a fixed duration, and
 * throws the state away. That is right for a bounce and wrong for playback:
 * calling it repeatedly to fill a queue restarts every filter, every envelope
 * and every oscillator phase at each chunk boundary, so the output clicks and
 * the note retriggers.
 *
 * This keeps one voice alive across calls. It is the same thing the worklet
 * does per block, minus the worklet.
 *
 * ## Who needs it
 *
 * Any host that has an audio output but no `AudioWorkletProcessor`. React
 * Native is the case that prompted it: `react-native-audio-api` has an audio
 * graph and a buffer queue but no spec worklet, so the only way to play a
 * crate Material continuously is to render ahead on the JS thread and feed
 * the queue. Node and Electron are in the same position for different
 * reasons.
 *
 * It is not a real-time path. Rendering happens on whatever thread calls
 * `render`, so a host has to stay ahead of the queue, and the latency is
 * however far ahead it chooses to be. What it buys is continuity, which is
 * the difference between a Material that plays and one that stutters.
 */
import { compileVoice, type CompiledVoice, type VoiceRuntimeState } from '../asl/compile';
import type { ASLGraphDescriptor } from '../asl/graph';
import type { KernelProcessor } from './kernel';

export interface BlockRendererOptions {
  sampleRate?: number;
  /** Bound to named kernel slots, as `OfflineRenderer` does. */
  kernels?: Record<string, KernelProcessor>;
  /** Applied as the opening `noteOn`, so the first block is already sounding. */
  params?: Record<string, number>;
}

/** One block of output. `right` aliases `left` for a mono graph. */
export interface RenderedBlock {
  left: Float32Array;
  right: Float32Array;
  /** False when the graph is mono and `right` is the same array as `left`. */
  stereo: boolean;
}

export class BlockRenderer {
  readonly sampleRate: number;
  private readonly voice: CompiledVoice;
  private state: VoiceRuntimeState;
  private readonly kernels: Record<string, KernelProcessor>;
  private left = new Float32Array(0);
  private right = new Float32Array(0);

  constructor(private readonly graph: ASLGraphDescriptor, options: BlockRendererOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.kernels = options.kernels ?? {};
    this.voice = compileVoice(graph);
    this.state = this.freshState();
    this.voice.noteOn(this.state, options.params ?? {});
  }

  /** Whether this graph is evaluated per channel rather than mirrored. */
  get stereo(): boolean {
    return this.voice.stereo;
  }

  noteOn(params: Record<string, number> = {}): void {
    this.voice.noteOn(this.state, params);
  }

  noteOff(): void {
    this.voice.noteOff(this.state);
  }

  setParam(name: string, value: number): void {
    this.voice.noteOn(this.state, { [name]: value });
  }

  /**
   * Starts over: a new voice state, and the note re-struck.
   *
   * Distinct from `noteOff` on purpose. `noteOff` releases and lets the tail
   * ring, which is what a key lift does; this discards the tail along with
   * every filter's memory, which is what stopping and restarting does.
   */
  reset(params: Record<string, number> = {}): void {
    this.state = this.freshState();
    this.voice.noteOn(this.state, params);
  }

  /**
   * Renders the next `frames` samples, continuing from the last call.
   *
   * The returned arrays are reused between calls, so a caller that keeps a
   * block must copy it. Reusing them is what lets a playback loop run without
   * allocating on every buffer, which is the whole point of rendering ahead.
   */
  render(frames: number, input?: Float32Array): RenderedBlock {
    if (frames < 0 || !Number.isFinite(frames)) {
      throw new RangeError(`BlockRenderer.render: frames must be a non-negative number, got ${frames}`);
    }
    if (this.left.length !== frames) {
      this.left = new Float32Array(frames);
      this.right = new Float32Array(frames);
    } else {
      this.left.fill(0);
      this.right.fill(0);
    }
    if (frames === 0) return { left: this.left, right: this.right, stereo: false };

    const wroteRight = this.voice.renderBlock(this.state, this.sampleRate, this.left, input, {
      outputR: this.right,
    });
    // `renderBlock` reports whether it filled the right channel rather than
    // the caller re-deriving the rule, because the wrong answer is either a
    // silent right side or a stereo image collapsed to mono.
    if (!wroteRight) this.right.set(this.left);
    return { left: this.left, right: this.right, stereo: wroteRight };
  }

  private freshState(): VoiceRuntimeState {
    const state = this.voice.createState();
    const entries = Object.entries(this.kernels);
    if (entries.length > 0) state.kernels = new Map(entries);
    return state;
  }

  /** The descriptor this was built from, for a host that wants to rebuild. */
  get descriptor(): ASLGraphDescriptor {
    return this.graph;
  }
}
