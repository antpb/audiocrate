/**
 * A `StreamSource` fed by audio rendered elsewhere: a track rendered ahead of
 * the playhead in a Worker (`render/trackRender.ts`) arrives here in chunks,
 * and this plays them as one continuous signal on the track's `StreamClip`.
 *
 * The rendered span is one contiguous run of song time. Chunks extend it;
 * playback from a position inside it is immediate, and from outside it asks
 * the host (`onNeed`) to render from there, then reports a stall until the
 * audio arrives, so `holdWhileBuffering` holds the transport rather than
 * playing silence. Chunks far behind the playhead are dropped.
 */
import type { StreamOutputNode, StreamSource } from './StreamClip';

interface AudioCtx {
  readonly currentTime: number;
  readonly sampleRate: number;
  createGain(): GainNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
}

interface Chunk {
  startSec: number;
  endSec: number;
  left: Float32Array;
  right: Float32Array;
  buffer?: AudioBuffer;
}

export interface RenderedStreamSourceOptions {
  durationSec: number;
  sampleRate: number;
  /** Asked to render from song time `fromSec` on; the span restarts there. */
  onNeed?: (fromSec: number) => void;
  /** Seconds kept behind the playhead (default 8). */
  keepBehindSec?: number;
  /** A stall is reported when less than this is buffered ahead (default 0.12 s). */
  stallMarginSec?: number;
}

export class RenderedStreamSource implements StreamSource {
  readonly durationSec: number;
  private readonly sampleRate: number;
  private chunks: Chunk[] = [];
  /** The span: [spanStart, spanEnd) of song time that chunks cover or will. */
  private spanStart = 0;
  private spanEnd = 0;
  private ctx: AudioCtx | null = null;
  private output: GainNode | null = null;
  private playing: { when: number; offset: number } | null = null;
  private scheduled = new Map<Chunk, AudioBufferSourceNode>();
  private stallListeners = new Set<(stalled: boolean) => void>();
  private stalled = false;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;

  constructor(private readonly options: RenderedStreamSourceOptions) {
    this.durationSec = options.durationSec;
    this.sampleRate = options.sampleRate;
  }

  /** The end of what is rendered, in song seconds. */
  get renderedUntilSec(): number {
    return this.spanEnd;
  }

  /** Starts a new span at `fromSec` (after asking the renderer to start there). */
  reset(fromSec: number): void {
    this.unscheduleAll();
    this.chunks = [];
    this.spanStart = this.spanEnd = Math.max(0, fromSec);
  }

  /**
   * Adds rendered audio for song time `startSec` on. Ignored unless it
   * continues the span: a chunk from a render the span has moved on from.
   */
  push(startSec: number, left: Float32Array, right: Float32Array): void {
    if (Math.abs(startSec - this.spanEnd) > 0.5 / this.sampleRate) return;
    const chunk: Chunk = { startSec, endSec: startSec + left.length / this.sampleRate, left, right };
    this.chunks.push(chunk);
    this.spanEnd = chunk.endSec;
    if (this.playing) this.schedule(chunk);
    if (this.stalled) this.emitStall(false);
  }

  outputFor(ctx: unknown): StreamOutputNode {
    const audio = ctx as AudioCtx;
    if (!this.output || this.ctx !== audio) {
      this.ctx = audio;
      this.output = audio.createGain();
    }
    return this.output as unknown as StreamOutputNode;
  }

  start(when: number, offsetSec: number): void {
    this.stop();
    const offset = Math.max(0, offsetSec);
    if (offset < this.spanStart || offset > this.spanEnd + 0.01) {
      this.reset(offset);
      this.options.onNeed?.(offset);
    }
    this.playing = { when, offset };
    this.lastHeard = offset;
    for (const chunk of this.chunks) this.schedule(chunk);
    this.monitor = setInterval(() => this.watch(), 50);
  }

  stop(): void {
    if (this.playing) this.lastHeard = this.mediaTimeSec();
    this.playing = null;
    if (this.monitor !== null) clearInterval(this.monitor);
    this.monitor = null;
    this.unscheduleAll();
  }

  mediaTimeSec(): number {
    if (!this.playing || !this.ctx) return this.lastHeard;
    const heard = this.playing.offset + Math.max(0, this.ctx.currentTime - this.playing.when);
    // Never past what exists: after a stall the transport is put back here.
    return Math.min(heard, this.spanEnd, this.durationSec);
  }

  bufferedAheadSec(atSec: number): number {
    if (atSec < this.spanStart - 1e-6 || atSec > this.spanEnd) return 0;
    return this.spanEnd - atSec;
  }

  onStall(listener: (stalled: boolean) => void): () => void {
    this.stallListeners.add(listener);
    return () => this.stallListeners.delete(listener);
  }

  dispose(): void {
    this.stop();
    this.chunks = [];
    this.stallListeners.clear();
  }

  private emitStall(value: boolean): void {
    this.stalled = value;
    for (const listener of this.stallListeners) listener(value);
  }

  private watch(): void {
    if (!this.playing) return;
    const heard = this.mediaTimeSec();
    const margin = this.options.stallMarginSec ?? 0.12;
    if (!this.stalled && this.spanEnd < this.durationSec - 1e-3 && this.spanEnd - heard < margin) this.emitStall(true);
    // Drop what is long behind.
    const keep = this.options.keepBehindSec ?? 8;
    while (this.chunks.length > 1 && this.chunks[0]!.endSec < heard - keep) {
      const old = this.chunks.shift()!;
      this.scheduled.delete(old);
      this.spanStart = this.chunks[0]!.startSec;
    }
  }

  private schedule(chunk: Chunk): void {
    const ctx = this.ctx;
    const out = this.output;
    const playing = this.playing;
    if (!ctx || !out || !playing || this.scheduled.has(chunk)) return;
    if (chunk.endSec <= playing.offset) return;
    if (!chunk.buffer) {
      chunk.buffer = ctx.createBuffer(2, chunk.left.length, this.sampleRate);
      chunk.buffer.copyToChannel(chunk.left as Float32Array<ArrayBuffer>, 0);
      chunk.buffer.copyToChannel(chunk.right as Float32Array<ArrayBuffer>, 1);
    }
    const node = ctx.createBufferSource();
    node.buffer = chunk.buffer;
    node.connect(out);
    const into = Math.max(0, playing.offset - chunk.startSec);
    const at = playing.when + Math.max(0, chunk.startSec - playing.offset);
    // A chunk that arrives after its moment (the render fell behind) starts
    // where the clock is, from the right place in it, rather than late.
    const late = Math.max(0, ctx.currentTime - at);
    node.start(at + late, into + late);
    this.scheduled.set(chunk, node);
  }

  private unscheduleAll(): void {
    for (const node of this.scheduled.values()) {
      try {
        node.stop();
        node.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.scheduled.clear();
  }
}

/**
 * Several sources seen as one, for a single `holdWhileBuffering`: heard where
 * the furthest-behind one is, buffered as little as the least-buffered one,
 * stalled while any is. One guard per source would have them pause and resume
 * the one transport against each other.
 */
export function combineStreamSources(sources: readonly StreamSource[]): StreamSource {
  return {
    get durationSec() {
      return Math.max(0, ...sources.map((s) => s.durationSec));
    },
    outputFor: () => {
      throw new Error('combineStreamSources is for buffering checks, not playback');
    },
    start: () => {},
    stop: () => {},
    mediaTimeSec: () => Math.min(...sources.map((s) => s.mediaTimeSec())),
    bufferedAheadSec: (atSec) => Math.min(...sources.map((s) => s.bufferedAheadSec(atSec))),
    onStall(listener) {
      const state = new Map<StreamSource, boolean>();
      const offs = sources.map((source) =>
        source.onStall((stalled) => {
          state.set(source, stalled);
          listener([...state.values()].some(Boolean));
        }),
      );
      return () => offs.forEach((off) => off());
    },
  };
}
