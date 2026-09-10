import { describe, expect, it } from 'vitest';
import { Time, time } from '../src/Time';

describe('Time.seconds / Time.beats', () => {
  it('round-trips through toSeconds', () => {
    expect(Time.seconds(1.5).toSeconds({ bpm: 120, ppqn: 24 })).toBe(1.5);
  });

  it('converts beats using the given bpm', () => {
    // 2 beats at 120bpm = 1 second
    expect(Time.beats(2).toSeconds({ bpm: 120, ppqn: 24 })).toBeCloseTo(1);
  });

  it('rejects non-finite values', () => {
    expect(() => Time.seconds(NaN)).toThrow(TypeError);
    expect(() => Time.beats(Infinity)).toThrow(TypeError);
  });
});

describe('Time.bars', () => {
  it('round-trips bar/beat/tick', () => {
    const t = Time.bars(2, 1, 0);
    expect(t.kind).toBe('bars');
    expect(t.bars).toEqual({ bar: 2, beat: 1, tick: 0 });
  });

  it('resolves against ppqn and bpm at schedule time, not construction time', () => {
    // bar 2, beat 1, tick 0 at 4/4, 120bpm = 4 beats in = 2 seconds
    const t = Time.bars(2, 1, 0);
    expect(t.toSeconds({ bpm: 120, ppqn: 24 })).toBeCloseTo(2);
    // the same Time value resolves differently against a different tempo
    expect(t.toSeconds({ bpm: 60, ppqn: 24 })).toBeCloseTo(4);
  });

  it('accounts for a nonzero tick using ppqn', () => {
    // bar 1 beat 1 tick 12 at ppqn 24 = half a beat in
    const t = Time.bars(1, 1, 12);
    expect(t.toSeconds({ bpm: 120, ppqn: 24 })).toBeCloseTo(0.25);
  });

  it('resolves 6/8 bars against the denominator, not six quarter notes', () => {
    const ctx = { bpm: 120, ppqn: 24, beatsPerBar: 6, beatUnit: 8 };
    expect(Time.bars(2, 1, 0).toSeconds(ctx)).toBeCloseTo(1.5);
    expect(Time.bars(1, 4, 0).toSeconds(ctx)).toBeCloseTo(0.75);
  });

  it('rejects a malformed value at construction, not at resolution', () => {
    expect(() => Time.bars(2, 1, 0, 0)).toThrow(TypeError); // a typo'd 4th argument
    expect(() => (Time.bars as (...a: number[]) => Time)(2, 1)).toThrow(TypeError); // too few
    expect(() => Time.bars(2.5, 1, 0)).toThrow(TypeError); // non-integer
    expect(() => Time.bars(0, 1, 0)).toThrow(RangeError); // bar is 1-indexed
    expect(() => Time.bars(1, 0, 0)).toThrow(RangeError); // beat is 1-indexed
    expect(() => Time.bars(1, 1, -1)).toThrow(RangeError); // tick can't go negative
  });
});

describe('Time.now', () => {
  it('reads the given scene explicitly, never a global', () => {
    const sceneA = { currentTime: 3.2 };
    const sceneB = { currentTime: 9.9 };
    expect(Time.now(sceneA).toSeconds({ bpm: 120, ppqn: 24 })).toBe(3.2);
    expect(Time.now(sceneB).toSeconds({ bpm: 120, ppqn: 24 })).toBe(9.9);
  });
});

describe('time tagged template sugar', () => {
  it('parses to the same structured value as Time.bars', () => {
    expect(time`2:1:0`.equals(Time.bars(2, 1, 0))).toBe(true);
  });

  it('supports interpolated expressions', () => {
    const bar = 3;
    expect(time`${bar}:1:0`.equals(Time.bars(3, 1, 0))).toBe(true);
  });

  it('rejects a malformed literal the same way the constructor does', () => {
    expect(() => time`2:1`).toThrow(TypeError); // missing a field
    expect(() => time`2:1:0:0`).toThrow(TypeError); // extra field
    expect(() => time`a:1:0`).toThrow(TypeError); // non-numeric
  });
});

describe('Time.equals', () => {
  it('is false across kinds even with an equivalent resolved value', () => {
    // 2 seconds vs 4 beats at 120bpm both resolve to 2s, but are not the same Time
    expect(Time.seconds(2).equals(Time.beats(4))).toBe(false);
  });
});
