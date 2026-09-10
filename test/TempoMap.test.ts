import { describe, expect, it } from 'vitest';
import { TempoMap } from '../src/TempoMap';
import { Time, time } from '../src/Time';

describe('TempoMap with no changes', () => {
  /**
   * This is the whole safety property. A scene that never builds a tempo map
   * must schedule exactly as it did before tempo maps existed, and "exactly"
   * has to mean the identical float, not a close one, or somebody's clips
   * move by a sample when they upgrade.
   */
  it('answers the constant-tempo formula, to the bit', () => {
    for (const bpm of [60, 87.5, 120, 128, 174, 200.3]) {
      const map = TempoMap.constant(bpm);
      for (const beats of [0, 1, 3.5, 16, 64, 129.7, 1000]) {
        expect(map.secondsAtBeat(beats)).toBe((beats * 60) / bpm);
      }
    }
  });

  it('inverts exactly', () => {
    const map = TempoMap.constant(128);
    for (const beats of [0, 1, 7.25, 64, 512]) {
      expect(map.beatAtSeconds(map.secondsAtBeat(beats))).toBeCloseTo(beats, 9);
    }
  });

  it('reports itself as constant', () => {
    expect(TempoMap.constant(120).isConstant).toBe(true);
    expect(new TempoMap([{ atBeat: 8, bpm: 140 }], 120).isConstant).toBe(false);
  });
});

describe('TempoMap with changes', () => {
  // 120 for the first four beats (2s), then 60.
  const map = new TempoMap([{ atBeat: 4, bpm: 60 }], 120);

  it('uses each tempo over its own span', () => {
    expect(map.secondsAtBeat(0)).toBe(0);
    expect(map.secondsAtBeat(2)).toBeCloseTo(1, 9);
    expect(map.secondsAtBeat(4)).toBeCloseTo(2, 9);
    // Beat 5 is one beat at 60 bpm past beat 4.
    expect(map.secondsAtBeat(5)).toBeCloseTo(3, 9);
    expect(map.secondsAtBeat(8)).toBeCloseTo(6, 9);
  });

  it('inverts across a change', () => {
    for (const beat of [0, 1, 3.99, 4, 4.01, 12, 100]) {
      expect(map.beatAtSeconds(map.secondsAtBeat(beat))).toBeCloseTo(beat, 9);
    }
  });

  it('lands the change on exactly the beat it names', () => {
    // Not one sample early, not one late. The two sides must agree at the seam.
    const atChange = map.secondsAtBeat(4);
    expect(map.beatAtSeconds(atChange)).toBeCloseTo(4, 12);
    expect(map.bpmAtBeat(4)).toBe(60);
    expect(map.bpmAtBeat(3.999999)).toBe(120);
  });

  it('reports the tempo at a beat and at a second', () => {
    expect(map.bpmAtBeat(0)).toBe(120);
    expect(map.bpmAtBeat(10)).toBe(60);
    expect(map.bpmAtSeconds(1)).toBe(120);
    expect(map.bpmAtSeconds(5)).toBe(60);
  });

  it('accumulates several changes without compounding error', () => {
    const many = new TempoMap(
      [
        { atBeat: 4, bpm: 60 },
        { atBeat: 8, bpm: 240 },
        { atBeat: 12, bpm: 120 },
      ],
      120,
    );
    // 4 beats at 120 = 2s, 4 at 60 = 4s, 4 at 240 = 1s, then 120.
    expect(many.secondsAtBeat(4)).toBeCloseTo(2, 9);
    expect(many.secondsAtBeat(8)).toBeCloseTo(6, 9);
    expect(many.secondsAtBeat(12)).toBeCloseTo(7, 9);
    expect(many.secondsAtBeat(16)).toBeCloseTo(9, 9);
    expect(many.beatAtSeconds(9)).toBeCloseTo(16, 9);
  });

  it('measures a span of beats from where it starts', () => {
    // Four beats mean different lengths in different parts of the song.
    expect(map.spanSeconds(0, 4)).toBeCloseTo(2, 9);
    expect(map.spanSeconds(4, 4)).toBeCloseTo(4, 9);
  });

  it('sorts unordered changes and lets a later duplicate win', () => {
    const messy = new TempoMap(
      [
        { atBeat: 8, bpm: 90 },
        { atBeat: 4, bpm: 60 },
        { atBeat: 8, bpm: 240 },
      ],
      120,
    );
    expect(messy.changes).toEqual([
      { atBeat: 4, bpm: 60, curve: 'jump' },
      { atBeat: 8, bpm: 240, curve: 'jump' },
    ]);
  });

  it('lets a change at beat zero replace the base tempo', () => {
    const zeroed = new TempoMap([{ atBeat: 0, bpm: 90 }], 120);
    expect(zeroed.baseBpm).toBe(90);
    expect(zeroed.secondsAtBeat(3)).toBeCloseTo(2, 9);
  });

  it('extrapolates before the origin rather than clamping', () => {
    // Something scheduled before the origin is a caller's problem to reject.
    // Silently piling it onto zero would hide it.
    expect(map.secondsAtBeat(-2)).toBeCloseTo(-1, 9);
    expect(map.beatAtSeconds(-1)).toBeCloseTo(-2, 9);
  });

  it('rejects nonsense at construction', () => {
    expect(() => new TempoMap([], 0)).toThrow(RangeError);
    expect(() => new TempoMap([], -120)).toThrow(RangeError);
    expect(() => new TempoMap([{ atBeat: 4, bpm: 0 }], 120)).toThrow(RangeError);
    expect(() => new TempoMap([{ atBeat: -1, bpm: 90 }], 120)).toThrow(RangeError);
    expect(() => new TempoMap([{ atBeat: Number.NaN, bpm: 90 }], 120)).toThrow(TypeError);
  });

  it('is immutable, so editing one gives a new one', () => {
    const edited = map.withChange(8, 90);
    expect(map.changes.length).toBe(1);
    expect(edited.changes.length).toBe(2);
    expect(edited.withoutChange(8).changes).toEqual(map.changes);
  });

  it('lists the changes ahead of a position, with their seconds', () => {
    const many = new TempoMap(
      [
        { atBeat: 4, bpm: 60 },
        { atBeat: 8, bpm: 240 },
      ],
      120,
    );
    expect(many.segmentsFromBeat(0).map((s) => s.atBeat)).toEqual([4, 8]);
    expect(many.segmentsFromBeat(5).map((s) => s.atBeat)).toEqual([8]);
    expect(many.segmentsFromBeat(99)).toEqual([]);
    expect(many.segmentsFromBeat(0)[1]!.atSeconds).toBeCloseTo(6, 9);
  });
});

describe('Time against a tempo map', () => {
  const ctx = { bpm: 120, ppqn: 24, beatsPerBar: 4 };

  it('resolves identically when no map is supplied', () => {
    // Every existing caller passes a context with no map. This is the shape
    // of that call, and it must not have changed.
    expect(Time.beats(4).toSeconds(ctx)).toBe(2);
    expect(Time.bars(3, 1, 0).toSeconds(ctx)).toBe(4);
    expect(time`2:1:0`.toSeconds(ctx)).toBe(2);
  });

  it('resolves identically against a constant map', () => {
    const mapped = { ...ctx, tempoMap: TempoMap.constant(120) };
    expect(Time.beats(4).toSeconds(mapped)).toBe(Time.beats(4).toSeconds(ctx));
    expect(Time.bars(3, 1, 0).toSeconds(mapped)).toBe(Time.bars(3, 1, 0).toSeconds(ctx));
  });

  it('follows a tempo change', () => {
    const mapped = { ...ctx, tempoMap: new TempoMap([{ atBeat: 4, bpm: 60 }], 120) };
    // Bar 2 beat 1 is beat 4, still at the old tempo's boundary.
    expect(Time.bars(2, 1, 0).toSeconds(mapped)).toBeCloseTo(2, 9);
    // Bar 3 beat 1 is beat 8, four beats later at half speed.
    expect(Time.bars(3, 1, 0).toSeconds(mapped)).toBeCloseTo(6, 9);
    expect(Time.bars(3, 1, 0).toSeconds(ctx)).toBe(4);
  });

  it('leaves a position given in seconds alone', () => {
    // A clip placed in seconds is placed in seconds. A tempo map is about
    // musical positions and must not move one that was never musical.
    const mapped = { ...ctx, tempoMap: new TempoMap([{ atBeat: 1, bpm: 30 }], 120) };
    expect(Time.seconds(1.5).toSeconds(mapped)).toBe(1.5);
  });

  it('resolves ticks through the map too', () => {
    const mapped = { ...ctx, tempoMap: new TempoMap([{ atBeat: 4, bpm: 60 }], 120) };
    // Bar 2 beat 2 tick 12 is beat 5.5, one and a half beats at 60 bpm.
    expect(Time.bars(2, 2, 12).toSeconds(mapped)).toBeCloseTo(3.5, 9);
  });
});

describe('TempoMap with ramps', () => {
  // 60 bpm at beat 0, ramping to 120 by beat 4, then holding 120.
  const ramp = new TempoMap(
    [
      { atBeat: 0, bpm: 60, curve: 'ramp' },
      { atBeat: 4, bpm: 120 },
    ],
    60,
  );

  it('interpolates the tempo linearly across the span', () => {
    expect(ramp.bpmAtBeat(0)).toBe(60);
    expect(ramp.bpmAtBeat(1)).toBeCloseTo(75, 9);
    expect(ramp.bpmAtBeat(2)).toBeCloseTo(90, 9);
    expect(ramp.bpmAtBeat(4)).toBe(120);
    // Past the ramp it holds at its destination.
    expect(ramp.bpmAtBeat(10)).toBe(120);
  });

  /**
   * The whole reason a ramp is not a lerp. Averaging the endpoints is the
   * obvious thing and it is wrong: the slow end of a ramp lasts longer than
   * the fast end, and a mean over beats does not know that.
   */
  it('integrates rather than averaging the endpoints', () => {
    const exact = (60 / 15) * Math.log(120 / 60);
    expect(ramp.secondsAtBeat(4)).toBeCloseTo(exact, 9);
    expect(ramp.secondsAtBeat(4)).toBeCloseTo(2.7726, 4);
    // What averaging 60 and 120 would have given.
    const averaged = (4 * 60) / 90;
    expect(averaged).toBeCloseTo(2.6667, 4);
    expect(Math.abs(ramp.secondsAtBeat(4) - averaged)).toBeGreaterThan(0.1);
  });

  it('inverts exactly across a ramp', () => {
    for (const beat of [0, 0.5, 1, 2, 3.75, 4, 4.001, 12]) {
      expect(ramp.beatAtSeconds(ramp.secondsAtBeat(beat))).toBeCloseTo(beat, 9);
    }
  });

  it('agrees with the constant path at both ends of the ramp', () => {
    // At the seam both descriptions of the same moment must match.
    const atEnd = ramp.secondsAtBeat(4);
    expect(ramp.beatAtSeconds(atEnd)).toBeCloseTo(4, 9);
    expect(ramp.bpmAtSeconds(atEnd)).toBeCloseTo(120, 6);
    expect(ramp.secondsAtBeat(0)).toBe(0);
  });

  it('is monotonic and slows down as it speeds up', () => {
    // Each successive beat takes less time than the one before it.
    const beatLengths = [0, 1, 2, 3, 4].map((b, i, all) =>
      i === 0 ? 0 : ramp.secondsAtBeat(b) - ramp.secondsAtBeat(all[i - 1]!),
    );
    for (let i = 2; i < beatLengths.length; i++) {
      expect(beatLengths[i]!).toBeLessThan(beatLengths[i - 1]!);
      expect(beatLengths[i]!).toBeGreaterThan(0);
    }
  });

  it('ramps downward too', () => {
    const slowing = new TempoMap(
      [
        { atBeat: 0, bpm: 120, curve: 'ramp' },
        { atBeat: 4, bpm: 60 },
      ],
      120,
    );
    expect(slowing.bpmAtBeat(2)).toBeCloseTo(90, 9);
    // The same integral, mirrored: the same total as ramping up between the
    // same two tempos, because it is the same span traversed backwards.
    expect(slowing.secondsAtBeat(4)).toBeCloseTo(ramp.secondsAtBeat(4), 9);
  });

  it('holds a ramp whose endpoints are the same tempo', () => {
    // Zero slope must land on the constant path, not a log of one.
    const flat = new TempoMap(
      [
        { atBeat: 0, bpm: 90, curve: 'ramp' },
        { atBeat: 4, bpm: 90 },
      ],
      90,
    );
    expect(flat.hasRamps).toBe(false);
    expect(flat.secondsAtBeat(4)).toBe((4 * 60) / 90);
  });

  it('holds a trailing ramp, because there is nothing to ramp to', () => {
    // An accelerando with no destination is a missing marker, not a shape.
    // Guessing one would invent a tempo nobody wrote.
    const trailing = new TempoMap([{ atBeat: 4, bpm: 90, curve: 'ramp' }], 120);
    expect(trailing.bpmAtBeat(100)).toBe(90);
    expect(trailing.secondsAtBeat(8)).toBe(trailing.secondsAtBeat(4) + (4 * 60) / 90);
  });

  it('leaves constant spans of a mixed map on the plain expression', () => {
    // A map that ramps somewhere must not put its constant spans on the log
    // path, or adding a ramp in bar 30 moves bar 2.
    const mixed = new TempoMap(
      [
        { atBeat: 8, bpm: 60, curve: 'ramp' },
        { atBeat: 16, bpm: 120 },
      ],
      120,
    );
    expect(mixed.secondsAtBeat(4)).toBe((4 * 60) / 120);
    expect(mixed.secondsAtBeat(8)).toBe((8 * 60) / 120);
  });

  it('chains a ramp into another ramp', () => {
    const chained = new TempoMap(
      [
        { atBeat: 0, bpm: 60, curve: 'ramp' },
        { atBeat: 4, bpm: 120, curve: 'ramp' },
        { atBeat: 8, bpm: 60 },
      ],
      60,
    );
    const up = (60 / 15) * Math.log(120 / 60);
    const down = (60 / -15) * Math.log(60 / 120);
    expect(chained.secondsAtBeat(8)).toBeCloseTo(up + down, 9);
    expect(chained.bpmAtBeat(6)).toBeCloseTo(90, 9);
    expect(chained.beatAtSeconds(chained.secondsAtBeat(6))).toBeCloseTo(6, 9);
  });

  it('reports its curves back out', () => {
    expect(ramp.baseCurve).toBe('ramp');
    expect(ramp.hasRamps).toBe(true);
    expect(ramp.changes).toEqual([{ atBeat: 4, bpm: 120, curve: 'jump' }]);
    expect(TempoMap.constant(120).hasRamps).toBe(false);
  });

  it('survives a round trip through its own accessors', () => {
    const rebuilt = new TempoMap(ramp.changes, ramp.baseBpm, ramp.baseCurve);
    expect(rebuilt.secondsAtBeat(4)).toBeCloseTo(ramp.secondsAtBeat(4), 12);
    expect(rebuilt.bpmAtBeat(2)).toBeCloseTo(ramp.bpmAtBeat(2), 12);
  });

  it('rejects an unknown curve', () => {
    // @ts-expect-error not a curve
    expect(() => new TempoMap([{ atBeat: 4, bpm: 90, curve: 'ease' }], 120)).toThrow(RangeError);
  });

  it('resolves a musical position through a ramp', () => {
    const ctx = { bpm: 60, ppqn: 24, beatsPerBar: 4, tempoMap: ramp };
    // Bar 2 beat 1 is beat 4, the end of the ramp.
    expect(Time.bars(2, 1, 0).toSeconds(ctx)).toBeCloseTo((60 / 15) * Math.log(2), 9);
  });
});
