/**
 * A jitter buffer for remote state.
 *
 * A WebRTC data channel delivers packets late, early, out of order, and
 * sometimes not at all. Applying each one the moment it lands produces the
 * zipper: a fader that jumps, stalls, jumps further. This keeps a ring of
 * timestamped snapshots per peer and renders at `now - renderDelay`,
 * finding the two snapshots that bracket that time and interpolating
 * between them. A fixed lag in exchange for smoothness. Values are scalar
 * lerps (gain, pan, playhead), not positions or orientations.
 *
 * **This is for state, not for audio.** A remote fader position, a peer's
 * playhead, an incoming automation stream. Do not put samples through it:
 * 100 ms of lag is usable on a meter and wrong on a signal.
 */

export interface Snapshot<T> {
  /** Session time this state was true at, not the time it arrived. */
  time: number;
  value: T;
}

export interface SnapshotBufferOptions {
  /**
   * How far behind the present to render, in seconds. Default 100 ms:
   * long enough to absorb ordinary jitter, short enough to stay under a
   * frame of UI lag at 10 Hz updates.
   */
  renderDelay?: number;
  /** Snapshots kept. Older ones fall off the back. */
  capacity?: number;
  /**
   * How far past the newest snapshot to keep extrapolating before holding
   * still, in seconds. Extrapolating forever turns a dropped peer into a
   * fader sliding off the end of its range.
   */
  maxExtrapolation?: number;
}

/**
 * A fixed-size ring of timestamped values with bracket-and-interpolate
 * sampling. Generic over the value so the same buffer serves a scalar fader,
 * a whole peer state record, or anything else with a sensible blend.
 */
export class SnapshotBuffer<T> {
  private readonly snapshots: Array<Snapshot<T>> = [];
  private readonly capacity: number;
  readonly renderDelay: number;
  readonly maxExtrapolation: number;

  constructor(
    private readonly blend: (a: T, b: T, t: number) => T,
    options: SnapshotBufferOptions = {},
  ) {
    this.renderDelay = options.renderDelay ?? 0.1;
    this.capacity = Math.max(2, options.capacity ?? 32);
    this.maxExtrapolation = options.maxExtrapolation ?? 0.25;
  }

  /**
   * Files a snapshot at the session time it describes. Out-of-order arrivals
   * are inserted in place rather than dropped, because a packet that took the
   * scenic route still carries state that was true when it was sent.
   */
  push(time: number, value: T): void {
    const snapshot = { time, value };
    const last = this.snapshots[this.snapshots.length - 1];
    if (!last || time >= last.time) {
      this.snapshots.push(snapshot);
    } else {
      let i = this.snapshots.length;
      while (i > 0 && this.snapshots[i - 1]!.time > time) i -= 1;
      this.snapshots.splice(i, 0, snapshot);
    }
    while (this.snapshots.length > this.capacity) this.snapshots.shift();
  }

  /** Newest snapshot time, or null when nothing has arrived. */
  get latestTime(): number | null {
    return this.snapshots[this.snapshots.length - 1]?.time ?? null;
  }

  get size(): number {
    return this.snapshots.length;
  }

  clear(): void {
    this.snapshots.length = 0;
  }

  /**
   * The value to show at session time `now`, which is read `renderDelay`
   * behind. Returns null only when nothing has ever arrived.
   */
  sample(now: number): T | null {
    const target = now - this.renderDelay;
    const count = this.snapshots.length;
    if (count === 0) return null;
    if (count === 1) return this.snapshots[0]!.value;

    const first = this.snapshots[0]!;
    // Behind everything held: the peer joined after this moment, so the
    // oldest thing known is the best answer.
    if (target <= first.time) return first.value;

    const last = this.snapshots[count - 1]!;
    if (target >= last.time) {
      const ahead = target - last.time;
      if (ahead > this.maxExtrapolation) return last.value;
      // Extrapolate along the last known trajectory, briefly. A peer whose
      // packets are a little late should keep moving, not stutter.
      const previous = this.snapshots[count - 2]!;
      const span = last.time - previous.time;
      if (span <= 0) return last.value;
      return this.blend(previous.value, last.value, 1 + ahead / span);
    }

    for (let i = count - 1; i > 0; i--) {
      const after = this.snapshots[i]!;
      const before = this.snapshots[i - 1]!;
      if (target >= before.time && target <= after.time) {
        const span = after.time - before.time;
        if (span <= 0) return after.value;
        return this.blend(before.value, after.value, (target - before.time) / span);
      }
    }
    return last.value;
  }
}

/** Linear blend, uncapped so extrapolation works. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Blends two records field by field, keeping a field only the later snapshot
 * has. Names in `stepFields` jump at the midpoint instead of blending:
 * interpolating a play flag halfway through its flip reads 0.5, which is
 * neither playing nor stopped, and a track index blended between 2 and 3 is
 * track 2.5. Which fields those are comes from the codec that declared them,
 * not from a list kept here.
 */
export function blendRecords(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
  t: number,
  stepFields: ReadonlySet<string> = EMPTY_STEPS,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key in b) {
    const from = a[key];
    if (from === undefined) {
      out[key] = b[key]!;
    } else if (stepFields.has(key)) {
      out[key] = t < 0.5 ? from : b[key]!;
    } else {
      out[key] = lerp(from, b[key]!, t);
    }
  }
  return out;
}

const EMPTY_STEPS: ReadonlySet<string> = new Set();

/** A record blender that respects one codec's `step` fields. */
export function recordBlender(
  stepFields: Iterable<string>,
): (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>, t: number) => Record<string, number> {
  const steps = new Set(stepFields);
  return (a, b, t) => blendRecords(a, b, t, steps);
}
