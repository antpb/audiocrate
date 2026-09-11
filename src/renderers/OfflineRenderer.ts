import type { TempoMap } from '../TempoMap';
import type { ASLGraphDescriptor } from '../asl/graph';
import { compileVoice } from '../asl/compile';
import type { AutomationLane } from '../automation/AutomationLane';
import type { KernelProcessor } from './kernel';
import type { TimeContext } from '../Time';

export interface OfflineRenderOptions {
  /** Total length of the render, in seconds. */
  duration: number;
  sampleRate?: number;
  /** Merged into noteOn's params at sample 0, e.g. { note: 69, velocity: 1, cutoff: 2000 }. */
  params?: Record<string, number>;
  /** Seconds into the render to call noteOff; omit to hold the note for the whole duration. */
  noteOffAt?: number;
  /**
   * Per-sample input signal for an effect AudioMaterial's `input` param node,
   * mirroring how the real-time worklet feeds a connected AudioNode's input
   * per sample (renderers/worklet/crate-voice-processor.ts). Ignored by
   * graphs that never read `input`.
   */
  inputSignal?: Float32Array;
  /**
   * Per-sample signal for the graph's other named audio ports
   * (`asl/ports.ts`), e.g. `{ sidechain: kickTrack }`. Mono: an offline
   * render is one channel, so `audio.left()` and `audio.right()` both read
   * the signal given here. A port with no entry reads 0.
   */
  portSignals?: Record<string, Float32Array>;
  /**
   * The musical position this render represents, for a graph that reads
   * `transport` nodes (`asl/transportNodes.ts`).
   *
   * **The transport rolls by default**, at `timeContext`'s tempo, from beat
   * zero. An offline render is a render of the song playing, so a synced
   * delay that came out silent because the transport was reported stopped
   * would be the wrong answer to the obvious question.
   */
  transport?: {
    bpm?: number;
    playing?: boolean;
    beatsPerBar?: number;
    beatUnit?: number;
    /** Where in the timeline this render starts. */
    startBeats?: number;
    /**
     * The song's tempo over time. A bounce has to follow the same map the
     * live path did, or an offline render of a song with a tempo change is a
     * different performance than the one that was played.
     */
    tempoMap?: TempoMap;
  };
  /**
   * DSP to bind to the graph's named kernel slots (`renderers/kernel.ts`),
   * so an offline render can run the same engines the live worklet would.
   * Slots the graph does not name are ignored; slots it names but this map
   * does not fill stay passthrough.
   *
   * Binding any kernel switches the render to 128-frame blocks, since a
   * block-rate kernel has no meaningful per-sample path.
   */
  kernels?: Record<string, KernelProcessor>;
  /** Lanes evaluated at the start of each block. */
  automation?: Array<{ target: string; lane: AutomationLane }>;
  timeContext?: TimeContext;
}

export interface OfflineRenderResult {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Renders an ASL graph to a buffer with no real-time constraint and no
 * AudioContext. Uses `compile.ts` directly: the same interpreter the
 * worklet runs, not a second implementation. Returns `{ samples, sampleRate }`
 * so a render-diff against a golden `.wav` has the rate on the result.
 */
export const OfflineRenderer = {
  render(graph: ASLGraphDescriptor, options: OfflineRenderOptions): OfflineRenderResult {
    const sampleRate = options.sampleRate ?? 48000;
    const totalSamples = Math.max(0, Math.round(options.duration * sampleRate));
    const noteOffSample = options.noteOffAt != null ? Math.round(options.noteOffAt * sampleRate) : null;

    const voice = compileVoice(graph);
    const state = voice.createState();
    const kernelEntries = Object.entries(options.kernels ?? {});
    if (kernelEntries.length > 0) state.kernels = new Map(kernelEntries);
    voice.noteOn(state, options.params ?? {});

    const timeCtx = options.timeContext ?? { bpm: 120, ppqn: 24, beatsPerBar: 4, beatUnit: 4 };
    const transportBpm = options.transport?.bpm ?? timeCtx.bpm;
    const transportPlaying = options.transport?.playing ?? true;
    const transportBeatsPerBar = options.transport?.beatsPerBar ?? timeCtx.beatsPerBar ?? 4;
    const transportBeatUnit = options.transport?.beatUnit ?? timeCtx.beatUnit ?? 4;
    const startBeats = options.transport?.startBeats ?? 0;
    const tempoMap = options.transport?.tempoMap ?? timeCtx.tempoMap;
    const startSeconds = tempoMap ? tempoMap.secondsAtBeat(startBeats) : 0;
    const beatsAt = (sample: number): number => {
      if (!transportPlaying) return startBeats;
      const elapsed = sample / sampleRate;
      return tempoMap
        ? tempoMap.beatAtSeconds(startSeconds + elapsed)
        : startBeats + elapsed * (transportBpm / 60);
    };
    const bpmAt = (sample: number): number =>
      tempoMap ? tempoMap.bpmAtBeat(beatsAt(sample)) : transportBpm;
    const portEntries = Object.entries(options.portSignals ?? {});
    const samples = new Float32Array(totalSamples);
    const blockSize = kernelEntries.length > 0 ? 128 : 1;
    for (let i = 0; i < totalSamples; ) {
      if (noteOffSample !== null && i === noteOffSample) {
        voice.noteOff(state);
      }
      if (options.automation) {
        const timelineSec = i / sampleRate;
        for (const { target, lane } of options.automation) {
          const value = lane.evaluate(timelineSec, timeCtx);
          if (value !== undefined) state.params[target] = value;
        }
      }
      const frames = Math.min(blockSize, totalSamples - i);
      state.transport = {
        beats: beatsAt(i),
        bpm: bpmAt(i),
        playing: transportPlaying,
        beatsPerBar: transportBeatsPerBar,
        beatUnit: transportBeatUnit,
      };
      if (blockSize === 1) {
        if (options.inputSignal) {
          state.params.input = options.inputSignal[i] ?? 0;
        }
        // The per-sample path has no blocks to index, so ports read the
        // scalar of the same name (`compile.ts`'s `port` case).
        for (const [name, signal] of portEntries) {
          state.params[name] = signal[i] ?? 0;
        }
        // The per-sample path has no block to index into, so the transport
        // snapshot is already this exact sample's position.
        state.frameIndex = 0;
        samples[i] = voice.renderSample(state, sampleRate);
        i += 1;
        continue;
      }
      const chunkOut = samples.subarray(i, i + frames);
      const chunkIn = options.inputSignal?.subarray(i, i + frames);
      let ports: Record<string, readonly (Float32Array | undefined)[]> | undefined;
      for (const [name, signal] of portEntries) {
        (ports ??= {})[name] = [signal.subarray(i, i + frames)];
      }
      voice.renderBlock(state, sampleRate, chunkOut, chunkIn, ports ? { ports } : undefined);
      i += frames;
    }

    return { samples, sampleRate };
  },
};
