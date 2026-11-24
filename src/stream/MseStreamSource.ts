import type { StreamOutputNode, StreamSource } from './StreamClip';
import { planStreamWork, segmentAt, type StreamSegment } from './fetchPlan';

/**
 * A `StreamSource` for browsers: Media Source Extensions feeding an audio
 * element, whose output joins the Web Audio graph through a
 * `MediaElementAudioSourceNode`. Analysers, meters and AudioMaterials keep
 * working, since none of this is DRM media.
 *
 * The media is a fragmented MP4 (or WebM) split into segments the host
 * knows the timing of. The host supplies how to fetch them (`loadInit`,
 * `loadSegment`): signed URLs, a playback session, retries and back-off
 * belong to the host, not to audiocrate. The source decides which segment
 * to fetch when (`fetchPlan.ts`) and keeps only a window around the
 * playhead buffered, so a long song never sits in memory.
 *
 * iPhone Safari has no `MediaSource`; iOS 17.1 and later have
 * `ManagedMediaSource`, which is used when present (it needs
 * `disableRemotePlayback`, and may ask the page to stop fetching while
 * enough is buffered).
 */

export interface MseStreamSourceOptions {
  /** e.g. `audio/mp4; codecs="mp4a.40.2"`. */
  mime: string;
  durationSec: number;
  segments: readonly StreamSegment[];
  loadInit(signal: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
  /**
   * A rejection is retried after a second, unless the error has
   * `fatal: true` (the host knows retrying cannot help: access was
   * withdrawn). Then the source stops fetching and reports it once.
   */
  loadSegment(index: number, signal: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
  /**
   * The element to play through. Pass one created (and played once) inside
   * a user gesture: Safari only lets an element play later if it was
   * started by a gesture first. Reused elements keep their source node.
   */
  element?: HTMLAudioElement;
  /** Seconds to keep buffered ahead of the playhead. Default 24. */
  aheadSec?: number;
  /** Seconds to keep behind the playhead, for short seeks back. Default 20. */
  behindSec?: number;
  /** A fetch or append failed. The source keeps retrying fetches unless the error is fatal. */
  onError?(error: Error): void;
}

type MediaSourceCtor = {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
};

function mediaSourceCtor(): { ctor: MediaSourceCtor; managed: boolean } | null {
  const g = globalThis as unknown as { ManagedMediaSource?: MediaSourceCtor; MediaSource?: MediaSourceCtor };
  if (g.ManagedMediaSource) return { ctor: g.ManagedMediaSource, managed: true };
  if (g.MediaSource) return { ctor: g.MediaSource, managed: false };
  return null;
}

// One source node per element, ever (a second createMediaElementSource
// throws), shared by every MseStreamSource that plays through it.
const elementNodes = new WeakMap<HTMLMediaElement, { ctx: unknown; node: StreamOutputNode }>();

const STALL_DEBOUNCE_MS = 150;
const RETRY_MS = 1000;

export class MseStreamSource implements StreamSource {
  /** True when this browser can stream `mime` through MSE. */
  static isSupported(mime: string): boolean {
    const found = mediaSourceCtor();
    try {
      return !!found && found.ctor.isTypeSupported(mime);
    } catch {
      return false;
    }
  }

  readonly element: HTMLAudioElement;
  readonly durationSec: number;
  private readonly options: MseStreamSourceOptions;
  private readonly mediaSource: MediaSource;
  private readonly managed: boolean;
  private readonly objectUrl: string;
  private readonly abort = new AbortController();
  private readonly segments: readonly StreamSegment[];
  private sourceBuffer: SourceBuffer | null = null;
  private opening: Promise<void> | null = null;
  private appended = new Set<number>();
  private inFlight = new Set<number>();
  /** One controller per segment fetch, so a seek can drop the ones it made pointless. */
  private fetches = new Map<number, AbortController>();
  private ctx: { currentTime: number } | null = null;
  private wantPlaying = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stalled = false;
  private pumping = false;
  private pumpQueued = false;
  private disposed = false;
  private failed: Error | null = null;
  private readonly stallListeners = new Set<(stalled: boolean) => void>();
  private readonly appendListeners = new Set<() => void>();
  private readonly cleanup: Array<() => void> = [];

  constructor(options: MseStreamSourceOptions) {
    const found = mediaSourceCtor();
    if (!found) throw new Error('This browser has no Media Source Extensions');
    if (!found.ctor.isTypeSupported(options.mime)) throw new Error(`This browser cannot stream ${options.mime}`);
    this.options = options;
    this.durationSec = options.durationSec;
    this.segments = options.segments;
    this.managed = found.managed;
    this.element = options.element ?? document.createElement('audio');
    this.element.preload = 'auto';
    if (this.managed) (this.element as HTMLAudioElement & { disableRemotePlayback: boolean }).disableRemotePlayback = true;
    this.mediaSource = new found.ctor();
    this.objectUrl = URL.createObjectURL(this.mediaSource);

    const on = (target: EventTarget, type: string, fn: () => void) => {
      target.addEventListener(type, fn);
      this.cleanup.push(() => target.removeEventListener(type, fn));
    };
    on(this.element, 'waiting', () => this.reportStall());
    on(this.element, 'playing', () => this.clearStall());
    on(this.element, 'timeupdate', () => this.schedulePump());
    on(this.element, 'seeking', () => {
      this.abortStale();
      this.schedulePump();
    });
    if (this.managed) {
      on(this.mediaSource, 'startstreaming', () => this.schedulePump());
      on(this.mediaSource, 'endstreaming', () => this.schedulePump());
    }
    this.element.src = this.objectUrl;
  }

  /** Opens the media source and appends the init segment. Idempotent. */
  open(): Promise<void> {
    if (!this.opening) this.opening = this.doOpen();
    return this.opening;
  }

  private async doOpen(): Promise<void> {
    if (this.mediaSource.readyState !== 'open') {
      await new Promise<void>((resolve) => this.mediaSource.addEventListener('sourceopen', () => resolve(), { once: true }));
    }
    if (this.disposed) return;
    this.mediaSource.duration = this.durationSec;
    this.sourceBuffer = this.mediaSource.addSourceBuffer(this.options.mime);
    await this.appendBytes(await this.options.loadInit(this.abort.signal));
    this.schedulePump();
  }

  /**
   * Resolves once `minAheadSec` (or the rest of the song) is buffered from
   * `atSec`, fetching from there first. Call before the first play, so play
   * starts without a stall.
   */
  async prime(atSec = 0, minAheadSec = 2): Promise<void> {
    await this.open();
    if (Math.abs(this.element.currentTime - atSec) > 0.01) this.element.currentTime = atSec;
    const need = () => Math.min(minAheadSec, Math.max(0, this.durationSec - atSec) - 0.05);
    if (this.bufferedAheadSec(atSec) >= need()) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.disposed || this.failed) {
          this.appendListeners.delete(check);
          reject(this.failed ?? new Error('Stream closed'));
        } else if (this.bufferedAheadSec(atSec) >= need()) {
          this.appendListeners.delete(check);
          resolve();
        }
      };
      this.appendListeners.add(check);
      this.schedulePump();
    });
  }

  outputFor(ctx: unknown): StreamOutputNode {
    this.ctx = ctx as { currentTime: number };
    const cached = elementNodes.get(this.element);
    if (cached && cached.ctx === ctx) return cached.node;
    if (cached) throw new Error('This audio element already plays through another AudioContext');
    const node = (ctx as { createMediaElementSource(el: HTMLMediaElement): StreamOutputNode }).createMediaElementSource(this.element);
    elementNodes.set(this.element, { ctx, node });
    return node;
  }

  start(when: number, offsetSec: number): void {
    this.wantPlaying = true;
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.element.pause();
    if (Math.abs(this.element.currentTime - offsetSec) > 0.02) this.element.currentTime = offsetSec;
    this.schedulePump();
    const go = () => {
      this.startTimer = null;
      if (!this.wantPlaying || this.disposed) return;
      this.element.play().catch((error: Error) => {
        if (error.name !== 'AbortError') this.options.onError?.(error);
      });
    };
    const delayMs = this.ctx ? (when - this.ctx.currentTime) * 1000 : 0;
    if (delayMs > 4) this.startTimer = setTimeout(go, delayMs);
    else go();
  }

  stop(): void {
    this.wantPlaying = false;
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.element.pause();
    this.clearStall();
  }

  mediaTimeSec(): number {
    return this.element.currentTime;
  }

  bufferedAheadSec(atSec: number): number {
    const ranges = this.sourceBuffer?.buffered;
    if (!ranges) return 0;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= atSec + 0.05 && ranges.end(i) > atSec) return ranges.end(i) - atSec;
    }
    return 0;
  }

  onStall(listener: (stalled: boolean) => void): () => void {
    this.stallListeners.add(listener);
    return () => this.stallListeners.delete(listener);
  }

  /** Stops fetching, releases the media source and detaches the element. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.abort.abort();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    for (const fn of this.cleanup) fn();
    for (const check of [...this.appendListeners]) check();
    this.element.removeAttribute('src');
    this.element.load();
    URL.revokeObjectURL(this.objectUrl);
  }

  // ── internals ─────────────────────────────────────────────────────────

  // 'waiting' also fires for a moment on an ordinary seek; only a wait that
  // lasts is a stall worth pausing the transport for.
  private reportStall(): void {
    if (!this.wantPlaying || this.stallTimer !== null) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (!this.wantPlaying || this.stalled) return;
      if (this.element.readyState >= 3 && !this.element.paused) return;
      this.stalled = true;
      for (const fn of this.stallListeners) fn(true);
    }, STALL_DEBOUNCE_MS);
    this.schedulePump();
  }

  private clearStall(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    if (!this.stalled) return;
    this.stalled = false;
    for (const fn of this.stallListeners) fn(false);
  }

  private schedulePump(): void {
    if (this.pumpQueued || this.disposed) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      void this.pump();
    });
  }

  // A fetch for a segment the playhead has jumped away from would spend
  // bandwidth (and any pacing budget the host's server keeps) on audio
  // nobody is about to hear. Drop it; the next pump plans from the new spot.
  private abortStale(): void {
    if (!this.fetches.size) return;
    const position = this.element.currentTime;
    const first = segmentAt(this.segments, position);
    const ahead = this.options.aheadSec ?? 24;
    for (const [index, controller] of this.fetches) {
      const s = this.segments[index];
      if (!s || index < first || s.start >= position + ahead) controller.abort();
    }
  }

  private isBuffered(index: number): boolean {
    const s = this.segments[index]!;
    return this.bufferedAheadSec(s.start + s.duration / 2) > 0;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed || this.failed || !this.sourceBuffer) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.disposed) return;
        // The browser may evict on its own under memory pressure.
        for (const i of [...this.appended]) if (!this.isBuffered(i)) this.appended.delete(i);
        const position = this.element.currentTime;
        const streaming = (this.mediaSource as MediaSource & { streaming?: boolean }).streaming;
        const work = planStreamWork({
          segments: this.segments,
          positionSec: position,
          appended: this.appended,
          inFlight: this.inFlight,
          aheadSec: this.options.aheadSec ?? 24,
          behindSec: this.options.behindSec ?? 20,
          allowFetch: !this.managed || streaming !== false || this.bufferedAheadSec(position) < 4,
        });
        if (work.kind === 'idle') {
          this.maybeEnd();
          return;
        }
        if (work.kind === 'evict') {
          await this.removeRange(work.start, work.end);
          for (const i of work.indices) this.appended.delete(i);
          continue;
        }
        this.inFlight.add(work.index);
        const controller = new AbortController();
        const forward = () => controller.abort();
        this.abort.signal.addEventListener('abort', forward, { once: true });
        this.fetches.set(work.index, controller);
        let bytes: ArrayBuffer | Uint8Array;
        try {
          bytes = await this.options.loadSegment(work.index, controller.signal);
        } catch (error) {
          this.inFlight.delete(work.index);
          if (this.disposed) return;
          // Dropped by a seek: not an error, plan again from the new position.
          if (controller.signal.aborted) continue;
          this.options.onError?.(error as Error);
          if ((error as { fatal?: boolean }).fatal) {
            this.failed = error as Error;
            for (const check of [...this.appendListeners]) check();
            return;
          }
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.schedulePump();
          }, RETRY_MS);
          return;
        } finally {
          this.fetches.delete(work.index);
          this.abort.signal.removeEventListener('abort', forward);
        }
        this.inFlight.delete(work.index);
        if (this.disposed) return;
        try {
          await this.appendBytes(bytes);
        } catch (error) {
          if ((error as Error).name !== 'QuotaExceededError') throw error;
          // Out of room: drop everything well behind the playhead, then retry.
          await this.removeRange(0, Math.max(0, this.element.currentTime - 2));
          for (const i of [...this.appended]) if (!this.isBuffered(i)) this.appended.delete(i);
          await this.appendBytes(bytes);
        }
        this.appended.add(work.index);
        for (const check of [...this.appendListeners]) check();
      }
    } catch (error) {
      if (!this.disposed) this.options.onError?.(error as Error);
    } finally {
      this.pumping = false;
    }
  }

  private maybeEnd(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.mediaSource.readyState !== 'open') return;
    if (this.appended.size !== this.segments.length) return;
    try {
      this.mediaSource.endOfStream();
    } catch {
      /* not allowed in this state; the next pump tries again */
    }
  }

  private whenIdle(sb: SourceBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', failed);
        resolve();
      };
      const failed = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', failed);
        reject(new Error('The browser could not take this audio segment'));
      };
      sb.addEventListener('updateend', done);
      sb.addEventListener('error', failed);
    });
  }

  private async appendBytes(bytes: ArrayBuffer | Uint8Array): Promise<void> {
    const sb = this.sourceBuffer;
    if (!sb) throw new Error('Stream is not open');
    if (sb.updating) await this.whenIdle(sb);
    const idle = this.whenIdle(sb);
    sb.appendBuffer(bytes as BufferSource);
    await idle;
  }

  private async removeRange(start: number, end: number): Promise<void> {
    const sb = this.sourceBuffer;
    if (!sb || end <= start) return;
    if (sb.updating) await this.whenIdle(sb);
    const idle = this.whenIdle(sb);
    sb.remove(start, end);
    await idle;
  }
}
