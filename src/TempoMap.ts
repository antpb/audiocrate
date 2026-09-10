/**
 * A song's tempo over time.
 *
 * Everything scheduled in crate is scheduled in **seconds**: one origin, PDC
 * offsets from it, `source.start(origin + offset)`. A tempo map does not
 * change that and must not. What it changes is the one question asked before
 * any of it, which is what second a musical position falls on.
 *
 * So this is a pure conversion between beats and seconds, with no reference to
 * an audio clock, a transport or a scene. It is consulted by `Time.toSeconds`
 * and by whoever needs to know the tempo at a moment, and it is invisible to
 * everything downstream of that.
 *
 * **A map with no changes answers exactly what the constant-tempo formula
 * answered.** Not approximately: the same expression, so a scene that never
 * builds one schedules bit-for-bit as it did before tempo maps existed. That
 * is the property the whole design is arranged around, because the alternative
 * is a framework where adding a feature nobody used moved everybody's clips.
 */

/**
 * How the tempo behaves over the span that **starts** at this change and runs
 * to the next one.
 *
 * `jump` holds this tempo until the next change, which is what a plain tempo
 * marker means. `ramp` moves linearly from this tempo to the next change's
 * tempo across the span, which is an accelerando or a ritardando.
 *
 * The curve belongs to the span after the marker rather than the one before
 * it, so "this section speeds up" is one change with a curve rather than a
 * property of the change that happens to end it.
 */
export type TempoCurve = 'jump' | 'ramp';

export interface TempoChange {
  /** Musical position of the change, in beats from the timeline origin. */
  readonly atBeat: number;
  readonly bpm: number;
  /** Defaults to `jump`. */
  readonly curve?: TempoCurve;
}

/**
 * One span, with its start precomputed in both units.
 *
 * `slope` is the tempo's rate of change in BPM per beat across this span, and
 * it is **exactly zero** for every constant span. That zero is load-bearing:
 * it is what selects the plain multiply-and-divide path, so a map with no
 * ramps computes through the identical expression a map without ramps ever
 * did, and so does every constant span of a map that has one elsewhere.
 */
interface Segment {
  readonly atBeat: number;
  readonly atSeconds: number;
  readonly bpm: number;
  readonly slope: number;
}

/**
 * Beats to seconds, written as `(beats * 60) / bpm` and not as
 * `beats * (60 / bpm)`.
 *
 * Those are not the same number. Pre-dividing rounds once more, and the two
 * disagree in the last bit at some tempos: 129.7 beats at 174 bpm differ by
 * one unit in the last place. That is inaudible and it is still not
 * acceptable here, because this expression is what every existing caller
 * already goes through, and a map with no changes has to return their answer
 * rather than one that is merely very close to it. A test asserts it to the
 * bit, and it caught this on the first run.
 */
function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm;
}

function secondsToBeats(seconds: number, bpm: number): number {
  return (seconds * bpm) / 60;
}

/**
 * Time across a span whose tempo moves linearly with the beat.
 *
 * With tempo `v(b) = v0 + k(b - b0)`, seconds accumulate as the integral of
 * `60 / v(b)`, which is `(60 / k) * ln(v(b) / v0)`. The naive alternative,
 * averaging the two tempos, is wrong in a way that looks right: a ramp from
 * 60 to 120 over four beats takes 2.77 seconds, not the 2.67 an average
 * gives, because the slow end of a ramp lasts longer than the fast end and a
 * mean over beats does not know that.
 *
 * `k` of exactly zero never reaches here. That is what keeps a constant span
 * on the plain expression.
 */
function rampSeconds(fromBpm: number, slope: number, beats: number): number {
  const endBpm = fromBpm + slope * beats;
  return (60 / slope) * Math.log(endBpm / fromBpm);
}

/** The inverse: how many beats a ramp covers in a given time. */
function rampBeats(fromBpm: number, slope: number, seconds: number): number {
  return (fromBpm * (Math.exp((slope * seconds) / 60) - 1)) / slope;
}

/** Seconds from a span's start to a beat inside it. */
function spanSecondsFrom(segment: { atBeat: number; bpm: number; slope: number }, beat: number): number {
  const beats = beat - segment.atBeat;
  // Outside the span, and on every constant span, the plain expression.
  return segment.slope !== 0 && beats > 0
    ? rampSeconds(segment.bpm, segment.slope, beats)
    : beatsToSeconds(beats, segment.bpm);
}

export class TempoMap {
  /** Ascending by `atBeat`. Always at least one, starting at beat 0. */
  private readonly segments: readonly Segment[];

  /**
   * `changes` may arrive unsorted and may contain a change at beat 0, which
   * replaces `baseBpm`. A later change at a beat already taken wins, because
   * an editor that writes the same position twice means the second one.
   */
  constructor(changes: readonly TempoChange[] = [], baseBpm = 120, baseCurve: TempoCurve = 'jump') {
    assertTempo('baseBpm', baseBpm);

    const byBeat = new Map<number, { bpm: number; curve: TempoCurve }>();
    for (const change of changes) {
      if (!Number.isFinite(change.atBeat)) {
        throw new TypeError(`TempoMap: atBeat must be finite, got ${String(change.atBeat)}`);
      }
      if (change.atBeat < 0) {
        throw new RangeError(`TempoMap: atBeat must not be negative, got ${change.atBeat}`);
      }
      assertTempo('bpm', change.bpm);
      if (change.curve !== undefined && change.curve !== 'jump' && change.curve !== 'ramp') {
        throw new RangeError(`TempoMap: curve must be 'jump' or 'ramp', got ${String(change.curve)}`);
      }
      byBeat.set(change.atBeat, { bpm: change.bpm, curve: change.curve ?? 'jump' });
    }

    const ordered = [...byBeat.entries()].sort((a, b) => a[0] - b[0]);
    const first = ordered[0];
    const start =
      first && first[0] === 0 ? first[1] : { bpm: baseBpm, curve: baseCurve };

    // Beats and tempos first, because a ramp's duration depends on where it
    // ends and the end is the next span's start.
    const spans: { atBeat: number; bpm: number; curve: TempoCurve }[] = [
      { atBeat: 0, bpm: start.bpm, curve: start.curve },
    ];
    for (const [atBeat, entry] of ordered) {
      if (atBeat === 0) continue;
      spans.push({ atBeat, bpm: entry.bpm, curve: entry.curve });
    }

    const segments: Segment[] = [];
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]!;
      const next = spans[i + 1];
      // A ramp needs somewhere to ramp to. The last span has no next tempo,
      // so it holds: an accelerando with no destination is not a shape, it is
      // a missing marker, and guessing one would invent a tempo nobody wrote.
      const slope =
        span.curve === 'ramp' && next && next.atBeat > span.atBeat
          ? (next.bpm - span.bpm) / (next.atBeat - span.atBeat)
          : 0;
      const previous = segments[segments.length - 1];
      const atSeconds = previous
        ? // Accumulated from the previous span's start, so rounding never
          // compounds across a run of changes the way repeated addition of a
          // per-beat increment would.
          previous.atSeconds + spanSecondsFrom(previous, span.atBeat)
        : 0;
      segments.push({ atBeat: span.atBeat, atSeconds, bpm: span.bpm, slope });
    }
    this.segments = segments;
  }

  /** A map that is one tempo throughout, which is the common case. */
  static constant(bpm: number): TempoMap {
    return new TempoMap([], bpm);
  }

  /** True when nothing changes, so a caller can take the cheap path. */
  get isConstant(): boolean {
    return this.segments.length === 1;
  }

  /** Tempo before the first change. */
  get baseBpm(): number {
    return this.segments[0]!.bpm;
  }

  /** The changes this map was built from, normalised and sorted. */
  get changes(): readonly TempoChange[] {
    return this.segments.slice(1).map(({ atBeat, bpm, slope }) => ({
      atBeat,
      bpm,
      curve: (slope !== 0 ? 'ramp' : 'jump') as TempoCurve,
    }));
  }

  /** The curve of the span before the first change. */
  get baseCurve(): TempoCurve {
    return this.segments[0]!.slope !== 0 ? 'ramp' : 'jump';
  }

  /** True when any span ramps rather than holding. */
  get hasRamps(): boolean {
    return this.segments.some((segment) => segment.slope !== 0);
  }

  bpmAtBeat(beat: number): number {
    const segment = this.segmentAtBeat(beat);
    if (segment.slope === 0) return segment.bpm;
    const beats = Math.max(0, beat - segment.atBeat);
    return segment.bpm + segment.slope * beats;
  }

  bpmAtSeconds(seconds: number): number {
    const segment = this.segmentAtSeconds(seconds);
    if (segment.slope === 0) return segment.bpm;
    return this.bpmAtBeat(this.beatAtSeconds(seconds));
  }

  /**
   * Seconds from the timeline origin to a musical position.
   *
   * A negative beat extrapolates backwards at the first segment's tempo
   * rather than clamping to zero. Clamping would silently pile everything
   * before the origin onto it, and something scheduled before the origin is a
   * caller's business to reject, not this function's to hide.
   */
  secondsAtBeat(beat: number): number {
    const segment = this.segmentAtBeat(beat);
    // The first segment starts at zero, so a map with no changes reduces to
    // `(beat * 60) / bpm` with no addition in the way.
    const offset = spanSecondsFrom(segment, beat);
    return segment.atSeconds === 0 ? offset : segment.atSeconds + offset;
  }

  /**
   * The inverse.
   *
   * `beatAtSeconds(secondsAtBeat(b))` returns `b` to within a few units in the
   * last place, not exactly. Each direction is one correctly-rounded
   * expression and the composition is two roundings, so the identity holds
   * only where the arithmetic happens to be exact: at 120 bpm, because 60/120
   * is a power of two. At 174 bpm beat 32 comes back 7.1e-15 high. That is
   * five orders of magnitude below one sample at 48 kHz and irrelevant to
   * scheduling, but it is not exactness and this used to claim it was.
   *
   * What *is* exact is each direction on its own: a constant map returns the
   * same bits as the plain constant-tempo formula, which is the property
   * clips are placed by. `fixtures/tempo-conformance.json` holds both, with
   * no tolerance on the queries and a stated one on the round trip.
   */
  beatAtSeconds(seconds: number): number {
    const segment = this.segmentAtSeconds(seconds);
    const elapsed = seconds - segment.atSeconds;
    const offset =
      segment.slope !== 0 && elapsed > 0
        ? rampBeats(segment.bpm, segment.slope, elapsed)
        : secondsToBeats(elapsed, segment.bpm);
    return segment.atBeat === 0 ? offset : segment.atBeat + offset;
  }

  /** How long a span of beats lasts, starting from a musical position. */
  spanSeconds(fromBeat: number, beats: number): number {
    return this.secondsAtBeat(fromBeat + beats) - this.secondsAtBeat(fromBeat);
  }

  /**
   * Every tempo change at or after `fromBeat`, with the second it falls on.
   * A renderer turns these into audio-clock times so the audio thread can
   * follow a tempo change without being told again.
   */
  segmentsFromBeat(
    fromBeat: number,
  ): readonly { atBeat: number; atSeconds: number; bpm: number; slope: number }[] {
    return this.segments
      .filter((segment) => segment.atBeat > fromBeat)
      .map(({ atBeat, atSeconds, bpm, slope }) => ({ atBeat, atSeconds, bpm, slope }));
  }

  /**
   * The span the playhead is inside, so a caller resuming mid-ramp can hand
   * the audio thread where it actually is rather than the last marker.
   */
  segmentAt(beat: number): { atBeat: number; atSeconds: number; bpm: number; slope: number } {
    const { atBeat, atSeconds, bpm, slope } = this.segmentAtBeat(beat);
    return { atBeat, atSeconds, bpm, slope };
  }

  /** A new map with one change added or replaced. Maps are immutable. */
  withChange(atBeat: number, bpm: number, curve: TempoCurve = 'jump'): TempoMap {
    return new TempoMap([...this.changes, { atBeat, bpm, curve }], this.baseBpm, this.baseCurve);
  }

  /** A new map without the change at `atBeat`, if there is one. */
  withoutChange(atBeat: number): TempoMap {
    return new TempoMap(
      this.changes.filter((change) => change.atBeat !== atBeat),
      this.baseBpm,
      this.baseCurve,
    );
  }

  private segmentAtBeat(beat: number): Segment {
    const segments = this.segments;
    // Linear from the end: a song has tens of tempo changes, and the caller
    // is usually near the last one it asked about. Not worth a binary search
    // until a map is large enough for one to matter.
    for (let i = segments.length - 1; i > 0; i--) {
      if (beat >= segments[i]!.atBeat) return segments[i]!;
    }
    return segments[0]!;
  }

  private segmentAtSeconds(seconds: number): Segment {
    const segments = this.segments;
    for (let i = segments.length - 1; i > 0; i--) {
      if (seconds >= segments[i]!.atSeconds) return segments[i]!;
    }
    return segments[0]!;
  }
}

function assertTempo(name: string, bpm: number): void {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) {
    throw new RangeError(`TempoMap: ${name} must be a positive finite number, got ${String(bpm)}`);
  }
}
