/**
 * Every value here is a structured `Time`, never a bare string or number
 * whose meaning depends on position. `bars`/`beats`/`ticks` are resolved
 * to seconds only at `toSeconds()`, against an explicit `TimeContext`
 * (bpm/ppqn), never against a hidden global transport.
 */

import type { TempoMap } from './TempoMap';
import { barBeats, signatureBeatBeats } from './asl/transportNodes';

type TimeValue =
  | { kind: 'seconds'; seconds: number }
  | { kind: 'beats'; beats: number }
  | { kind: 'bars'; bar: number; beat: number; tick: number };

export interface TimeContext {
  bpm: number;
  ppqn: number;
  /** Time-signature numerator. */
  beatsPerBar?: number;
  /** Time-signature denominator. 4 is a quarter, 8 is an eighth. Absent means 4. */
  beatUnit?: number;
  /**
   * The song's tempo over time. Absent means one constant tempo at `bpm`,
   * which is the path every existing caller takes and which resolves through
   * the identical expression it always did.
   *
   * When present, `bpm` is still meaningful as the tempo the transport
   * reports; the map is what a musical position is resolved against.
   */
  tempoMap?: TempoMap;
}

/**
 * The one place a musical position becomes seconds. Both non-seconds branches
 * of `toSeconds` funnel through here, so a tempo map has exactly one hook to
 * reach and the constant-tempo path is provably unchanged.
 */
function beatsToSeconds(totalBeats: number, ctx: TimeContext): number {
  return ctx.tempoMap ? ctx.tempoMap.secondsAtBeat(totalBeats) : (totalBeats * 60) / ctx.bpm;
}

function assertFinite(name: string, v: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`Time.${name} expects a finite number, got ${String(v)}`);
  }
}

function assertInteger(context: string, field: string, v: number): void {
  if (!Number.isInteger(v)) {
    throw new TypeError(`${context}: ${field} must be an integer, got ${String(v)}`);
  }
}

export class Time {
  private constructor(private readonly value: TimeValue) {}

  static seconds(seconds: number): Time {
    assertFinite('seconds', seconds);
    return new Time({ kind: 'seconds', seconds });
  }

  static beats(beats: number): Time {
    assertFinite('beats', beats);
    return new Time({ kind: 'beats', beats });
  }

  /**
   * Bar/beat/tick are all 1-indexed except tick (0-indexed), matching how
   * musicians count ("bar 2, beat 1"). Takes a rest parameter so a 4th
   * positional argument is a runtime error, not a silently ignored extra.
   */
  static bars(...args: number[]): Time {
    if (args.length !== 3) {
      throw new TypeError(`Time.bars requires exactly 3 arguments (bar, beat, tick), got ${args.length}`);
    }
    const [bar, beat, tick] = args as [number, number, number];
    assertInteger('Time.bars', 'bar', bar);
    assertInteger('Time.bars', 'beat', beat);
    assertInteger('Time.bars', 'tick', tick);
    if (bar < 1) throw new RangeError(`Time.bars: bar is 1-indexed, got ${bar}`);
    if (beat < 1) throw new RangeError(`Time.bars: beat is 1-indexed, got ${beat}`);
    if (tick < 0) throw new RangeError(`Time.bars: tick must be >= 0, got ${tick}`);
    return new Time({ kind: 'bars', bar, beat, tick });
  }

  /** The given scene's current context time. Explicit about which scene, never a global "now". */
  static now(scene: { currentTime: number }): Time {
    return Time.seconds(scene.currentTime);
  }

  get kind(): TimeValue['kind'] {
    return this.value.kind;
  }

  /** Structured fields for the 'bars' kind, for callers that need to inspect rather than resolve. */
  get bars(): { bar: number; beat: number; tick: number } | undefined {
    if (this.value.kind !== 'bars') return undefined;
    const { bar, beat, tick } = this.value;
    return { bar, beat, tick };
  }

  /**
   * This position in quarter-note beats.
   *
   * A host placing a clip needs beats, not seconds: beats are what a tempo
   * map is indexed by and what survives a tempo change. `toSeconds` is not
   * expressed through this on purpose. A `seconds` position converted to
   * beats and back is two roundings rather than an identity, and `toSeconds`
   * has to keep returning exactly what it always returned.
   */
  toBeats(ctx: TimeContext): number {
    switch (this.value.kind) {
      case 'seconds':
        return ctx.tempoMap
          ? ctx.tempoMap.beatAtSeconds(this.value.seconds)
          : (this.value.seconds * ctx.bpm) / 60;
      case 'beats':
        return this.value.beats;
      case 'bars': {
        const { bar, beat, tick } = this.value;
        return (
          (bar - 1) * barBeats(ctx.beatsPerBar, ctx.beatUnit) +
          (beat - 1) * signatureBeatBeats(ctx.beatUnit) +
          tick / ctx.ppqn
        );
      }
    }
  }

  toSeconds(ctx: TimeContext): number {
    switch (this.value.kind) {
      case 'seconds':
        return this.value.seconds;
      case 'beats':
        return beatsToSeconds(this.value.beats, ctx);
      case 'bars': {
        const { bar, beat, tick } = this.value;
        const totalBeats =
          (bar - 1) * barBeats(ctx.beatsPerBar, ctx.beatUnit) +
          (beat - 1) * signatureBeatBeats(ctx.beatUnit) +
          tick / ctx.ppqn;
        return beatsToSeconds(totalBeats, ctx);
      }
    }
  }

  equals(other: Time): boolean {
    const a = this.value;
    const b = other.value;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'seconds' && b.kind === 'seconds') return a.seconds === b.seconds;
    if (a.kind === 'beats' && b.kind === 'beats') return a.beats === b.beats;
    if (a.kind === 'bars' && b.kind === 'bars') {
      return a.bar === b.bar && a.beat === b.beat && a.tick === b.tick;
    }
    return false;
  }

  toString(): string {
    switch (this.value.kind) {
      case 'seconds':
        return `${this.value.seconds}s`;
      case 'beats':
        return `${this.value.beats}b`;
      case 'bars':
        return `${this.value.bar}:${this.value.beat}:${this.value.tick}`;
    }
  }
}

/**
 * `time\`2:1:0\`` sugar. A tagged template is a distinct syntax from a
 * runtime string: the shape of the call site is what a linter or editor
 * tool can validate. It resolves to the same `Time.bars` value, not an
 * independent parser with its own edge cases.
 */
export function time(strings: TemplateStringsArray, ...exprs: unknown[]): Time {
  const full = strings.reduce((acc, str, i) => acc + str + (i < exprs.length ? String(exprs[i]) : ''), '');
  const parts = full.split(':').map((s) => s.trim());
  if (parts.length !== 3) {
    throw new TypeError(`time\`${full}\` must have exactly three ":"-separated fields (bar:beat:tick), got ${parts.length}`);
  }
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n))) {
    throw new TypeError(`time\`${full}\` fields must all be integers, got "${full}"`);
  }
  return Time.bars(nums[0]!, nums[1]!, nums[2]!);
}
