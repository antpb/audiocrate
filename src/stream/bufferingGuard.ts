import type { Transport } from '../Transport';
import type { StreamSource } from './StreamClip';

/**
 * Keeps the transport honest about a network stream: when the source runs
 * out of data, pause the transport at the position actually heard; when
 * enough is buffered again, play from there.
 *
 * This is how a stream fits audiocrate's one scheduling origin. The
 * transport never keeps counting through silence, so its position (and
 * everything scheduled from it: other clips, MIDI, automation, a waveform
 * cursor) always matches what the listener hears.
 */

export interface BufferingGuardOptions {
  /** Where the stream sits on the timeline, seconds. Default 0. */
  timelineOffsetSec?: number;
  /** Buffered seconds needed before playing again. Default 3. */
  resumeAheadSec?: number;
  /** False once the host no longer wants to play (the user paused). Default: always true. */
  shouldResume?: () => boolean;
  onChange?: (buffering: boolean) => void;
  /** How often to check the buffer while held, ms. Default 200. */
  pollMs?: number;
}

export interface BufferingGuard {
  readonly buffering: boolean;
  dispose(): void;
}

export function holdWhileBuffering(
  scene: { readonly transport: Transport },
  source: StreamSource,
  options: BufferingGuardOptions = {},
): BufferingGuard {
  const offset = options.timelineOffsetSec ?? 0;
  const resumeAhead = options.resumeAheadSec ?? 3;
  const shouldResume = options.shouldResume ?? (() => true);
  let buffering = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const set = (value: boolean): void => {
    if (buffering === value) return;
    buffering = value;
    options.onChange?.(value);
  };

  const clear = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const check = (): void => {
    if (disposed) return;
    if (!shouldResume()) {
      clear();
      set(false);
      return;
    }
    const heard = source.mediaTimeSec();
    const remaining = Math.max(0, source.durationSec - heard);
    if (source.bufferedAheadSec(heard) + 0.01 >= Math.min(resumeAhead, remaining)) {
      clear();
      set(false);
      if (scene.transport.state !== 'playing') scene.transport.play();
    }
  };

  const unsubscribe = source.onStall((stalled) => {
    if (disposed) return;
    if (stalled) {
      if (scene.transport.state !== 'playing') return;
      const heard = source.mediaTimeSec();
      scene.transport.pause();
      scene.transport.seek(offset + heard);
      set(true);
      clear();
      timer = setInterval(check, options.pollMs ?? 200);
    } else if (buffering) {
      check();
    }
  });

  return {
    get buffering() {
      return buffering;
    },
    dispose() {
      disposed = true;
      clear();
      unsubscribe();
    },
  };
}
