import { Time, type TimeContext } from '../Time';
import { Easing, type EasingFn } from './Easing';

export interface AutomationRange {
  start: Time;
  end: Time;
}

export interface AutomationLaneOptions {
  /** Shape used when `from`/`to` are set. Ignored when `points` is set. */
  shape?: EasingFn;
  from?: number;
  to?: number;
  range: AutomationRange;
  /**
   * Baked 0..1 progress samples. `t` is normalized across the range
   * (or, for a clip lane, across file duration). `value` is the
   * already-authored output (param units for scene lanes, 0..127 for
   * project lanes). When present, this is the source of truth and
   * shape/from/to are ignored.
   */
  points?: Array<{ t: number; value: number }>;
  /** Jump to the value at the playhead when playback starts mid-lane. */
  chase?: boolean;
  /** Hold the last value after range.end. Default is hold. */
  hold?: boolean;
  invert?: boolean;
}

/**
 * Chase/hold: before the range, no write; inside, interpolate; after the
 * end, hold the last value when `hold` is true.
 */
export class AutomationLane {
  readonly shape: EasingFn;
  readonly from: number;
  readonly to: number;
  readonly range: AutomationRange;
  readonly points: Array<{ t: number; value: number }> | null;
  readonly chase: boolean;
  readonly hold: boolean;
  readonly invert: boolean;

  constructor(options: AutomationLaneOptions) {
    this.shape = options.shape ?? Easing.linear;
    this.from = options.from ?? 0;
    this.to = options.to ?? 1;
    this.range = options.range;
    this.points = options.points && options.points.length > 0 ? options.points : null;
    this.chase = options.chase !== false;
    this.hold = options.hold !== false;
    this.invert = options.invert === true;
  }

  /**
   * Value at `timelineSec`, or undefined when the lane has not started
   * (and chase is not inventing a pre-roll write).
   */
  evaluate(timelineSec: number, ctx: TimeContext): number | undefined {
    const start = this.range.start.toSeconds(ctx);
    const end = this.range.end.toSeconds(ctx);
    const span = end - start;
    if (!(span > 0)) return undefined;
    if (timelineSec < start) return undefined;
    if (timelineSec > end && !this.hold) return undefined;
    const u = Math.min(1, Math.max(0, (timelineSec - start) / span));
    return this.valueAt(u);
  }

  valueAt(u: number): number {
    if (this.points) return lerpPoints(this.points, u);
    const shaped = this.shape(u);
    const lo = Math.min(this.from, this.to);
    const hi = Math.max(this.from, this.to);
    let value = this.from + (this.to - this.from) * shaped;
    if (this.invert) value = lo + hi - value;
    return value;
  }
}

export function lerpPoints(points: Array<{ t: number; value: number }>, t: number): number {
  if (points.length === 0) return 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (t <= first.t) return first.value;
  if (t >= last.t) return last.value;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const local = span > 0 ? (t - a.t) / span : 0;
      return a.value + local * (b.value - a.value);
    }
  }
  return first.value;
}

export function mapDisplay127(raw127: number, min: number, max: number): number {
  return min + (raw127 / 127) * (max - min);
}
