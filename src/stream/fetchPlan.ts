/**
 * What a segmented stream should do next, as a pure function of where the
 * playhead is and what is already buffered. `MseStreamSource` calls this in
 * a loop; keeping the policy here means it can be tested without a browser.
 *
 * The policy: always fetch the segment under the playhead first, then fill
 * forward to `aheadSec`, one segment at a time, never further. Drop what is
 * more than `behindSec` behind the playhead, or far ahead of it after a
 * backward seek. Memory is therefore bounded by about
 * `aheadSec + behindSec` of compressed audio, whatever the song's length.
 */

export interface StreamSegment {
  /** Media time of the segment's first sample, seconds. */
  start: number;
  duration: number;
}

export type StreamWork =
  | { kind: 'fetch'; index: number }
  | { kind: 'evict'; start: number; end: number; indices: number[] }
  | { kind: 'idle' };

export interface StreamWorkInput {
  segments: readonly StreamSegment[];
  positionSec: number;
  /** Segments appended and still buffered. */
  appended: ReadonlySet<number>;
  /** Segments being fetched now. */
  inFlight: ReadonlySet<number>;
  aheadSec: number;
  behindSec: number;
  /** Fetches allowed at all (a ManagedMediaSource may ask us to hold off). */
  allowFetch?: boolean;
  /** Most concurrent fetches. Default 1: segments arrive in order. */
  maxInFlight?: number;
}

/** Index of the segment containing `sec`, clamped to the first and last. */
export function segmentAt(segments: readonly StreamSegment[], sec: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid]!.start <= sec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function planStreamWork(input: StreamWorkInput): StreamWork {
  const { segments, positionSec, appended, inFlight, aheadSec, behindSec } = input;
  if (!segments.length) return { kind: 'idle' };
  const current = segmentAt(segments, positionSec);
  const canFetch = (input.allowFetch ?? true) && inFlight.size < (input.maxInFlight ?? 1);

  // The segment being heard comes before anything else.
  if (canFetch && !appended.has(current) && !inFlight.has(current)) return { kind: 'fetch', index: current };

  const keepFrom = positionSec - behindSec;
  const keepTo = positionSec + aheadSec + (segments[current]?.duration ?? 0);
  const stale = [...appended]
    .filter((i) => {
      const s = segments[i];
      return !!s && (s.start + s.duration < keepFrom || s.start > keepTo);
    })
    .sort((a, b) => a - b);
  if (stale.length) {
    // One contiguous run at a time, so a removal never touches kept data.
    const run = [stale[0]!];
    for (let k = 1; k < stale.length && stale[k] === run[run.length - 1]! + 1; k++) run.push(stale[k]!);
    const first = segments[run[0]!]!;
    const last = segments[run[run.length - 1]!]!;
    return { kind: 'evict', start: first.start, end: last.start + last.duration, indices: run };
  }

  if (canFetch) {
    for (let i = current; i < segments.length && segments[i]!.start < positionSec + aheadSec; i++) {
      if (!appended.has(i) && !inFlight.has(i)) return { kind: 'fetch', index: i };
    }
  }
  return { kind: 'idle' };
}
