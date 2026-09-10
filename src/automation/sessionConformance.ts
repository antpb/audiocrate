/**
 * The musical-position and automation fixture, as a value.
 *
 * Slice 3 of the session layer, and the last set of inputs the plan document
 * needs. `tempoConformance` answers what second a beat falls on;
 * `clipConformance` answers what plays then; this answers **which beat a
 * musical position is** and **what a parameter is worth at that instant**.
 *
 * Two rules here are ones this project has already written down and can only
 * enforce in one language:
 *
 *  - **Beats are quarter-notes and the signature is two separate numbers.**
 *    `barBeats(6, 8)` is 3, not 6, because six eighth-notes are three
 *    quarter-notes. Folding the denominator into tempo instead is the
 *    documented mistake, and it is invisible in 4/4, which is most projects.
 *  - **Chase and hold.** Before a lane starts there is no write at all, which
 *    is not the same as writing its first value; after it ends the last value
 *    is held. A port that returns a number where crate returns nothing
 *    overwrites whatever the user set by hand.
 *
 * `linear`, `sCurve`, the lerp and the 0..127 map are plain arithmetic and are
 * compared to the bit. `exp`, `log` and `swell` reach `pow` and `sin`, so they
 * carry the stated tolerance and are marked.
 */
import { Time, type TimeContext } from '../Time';
import { TempoMap } from '../TempoMap';
import { barBeats, normalizeBeatUnit, signatureBeatBeats } from '../asl/transportNodes';
import { Easing, type EasingName } from './Easing';
import { AutomationLane, lerpPoints, mapDisplay127 } from './AutomationLane';

/**
 * Bumped when the shape changes, not when the maths does.
 *
 * 1: signatures, positions, easing, lanes, lerp, the 0..127 map.
 */
export const SESSION_CONFORMANCE_FIXTURE_VERSION = 1;

/** Deviation allowed where a case reaches `pow` or `sin`. */
export const SESSION_TRANSCENDENTAL_TOLERANCE = 1e-12;

export interface SignatureCase {
  beatsPerBar: number | null;
  beatUnit: number | null;
  normalizedUnit: number;
  signatureBeat: number;
  bar: number;
}

export interface PositionCase {
  name: string;
  /** 'seconds' | 'beats' | 'bars'. */
  kind: string;
  seconds?: number;
  beats?: number;
  bar?: number;
  beat?: number;
  tick?: number;
  ctx: {
    bpm: number;
    ppqn: number;
    beatsPerBar?: number;
    beatUnit?: number;
    /** A tempo map as changes, or null for a constant tempo. */
    tempoChanges: Array<{ atBeat: number; bpm: number; curve: string }> | null;
  };
  toBeats: number;
  toSeconds: number;
  /** False where a tempo map with a ramp is in the way. */
  exact: boolean;
}

export interface EasingCase {
  name: string;
  u: number;
  value: number;
  exact: boolean;
}

export interface LaneCase {
  name: string;
  startBeats: number;
  endBeats: number;
  from: number;
  to: number;
  shape: EasingName;
  points: Array<{ t: number; value: number }> | null;
  chase: boolean;
  hold: boolean;
  invert: boolean;
  bpm: number;
  /** Value at each probe, or null where the lane does not write. */
  samples: Array<{ timelineSec: number; value: number | null }>;
  exact: boolean;
}

export interface LerpCase {
  name: string;
  points: Array<{ t: number; value: number }>;
  probes: Array<{ t: number; value: number }>;
}

export interface Display127Case {
  raw127: number;
  min: number;
  max: number;
  value: number;
}

export interface SessionConformanceFixture {
  note: string;
  version: number;
  stamp: string;
  tolerance: number;
  signatures: SignatureCase[];
  positions: PositionCase[];
  easings: EasingCase[];
  lanes: LaneCase[];
  lerps: LerpCase[];
  display127: Display127Case[];
}

/**
 * Signatures worth asking about. 6/8 and 2/2 are the two that separate
 * "beats are quarter-notes" from "beats are whatever the signature says", and
 * the nulls are the absent-field path every 4/4 project takes.
 */
const SIGNATURE_INPUTS: Array<[number | null, number | null]> = [
  [4, 4], [3, 4], [6, 8], [12, 8], [2, 2], [5, 4], [7, 8],
  [null, null], [4, null], [null, 8], [0, 4], [4, 0], [4, -1],
];

const RAMPED = [
  { atBeat: 0, bpm: 90, curve: 'ramp' },
  { atBeat: 8, bpm: 160, curve: 'jump' },
];
const STEPPED = [{ atBeat: 4, bpm: 90, curve: 'jump' }];

const POSITION_INPUTS: Array<Omit<PositionCase, 'toBeats' | 'toSeconds' | 'exact'>> = [
  {
    name: 'bar 1 beat 1 tick 0 is the origin',
    kind: 'bars', bar: 1, beat: 1, tick: 0,
    ctx: { bpm: 120, ppqn: 960, tempoChanges: null },
  },
  {
    name: 'bar 3 in 4/4',
    kind: 'bars', bar: 3, beat: 1, tick: 0,
    ctx: { bpm: 120, ppqn: 960, beatsPerBar: 4, beatUnit: 4, tempoChanges: null },
  },
  {
    name: 'bar 3 in 6/8 is not bar 3 in 4/4',
    kind: 'bars', bar: 3, beat: 1, tick: 0,
    ctx: { bpm: 120, ppqn: 960, beatsPerBar: 6, beatUnit: 8, tempoChanges: null },
  },
  {
    name: 'beat 4 of a 6/8 bar',
    kind: 'bars', bar: 2, beat: 4, tick: 0,
    ctx: { bpm: 120, ppqn: 960, beatsPerBar: 6, beatUnit: 8, tempoChanges: null },
  },
  {
    name: 'cut time, where a beat is two quarters',
    kind: 'bars', bar: 3, beat: 2, tick: 0,
    ctx: { bpm: 100, ppqn: 960, beatsPerBar: 2, beatUnit: 2, tempoChanges: null },
  },
  {
    name: 'ticks are a fraction of a quarter note',
    kind: 'bars', bar: 1, beat: 1, tick: 480,
    ctx: { bpm: 120, ppqn: 960, beatsPerBar: 4, beatUnit: 4, tempoChanges: null },
  },
  {
    name: '7/8, where nothing divides evenly',
    kind: 'bars', bar: 4, beat: 5, tick: 240,
    ctx: { bpm: 137, ppqn: 480, beatsPerBar: 7, beatUnit: 8, tempoChanges: null },
  },
  {
    name: 'plain beats',
    kind: 'beats', beats: 12.5,
    ctx: { bpm: 120, ppqn: 960, tempoChanges: null },
  },
  {
    name: 'plain seconds convert back to beats',
    kind: 'seconds', seconds: 6,
    ctx: { bpm: 120, ppqn: 960, tempoChanges: null },
  },
  {
    name: 'bars against a stepped tempo map',
    kind: 'bars', bar: 4, beat: 1, tick: 0,
    ctx: { bpm: 120, ppqn: 960, beatsPerBar: 4, beatUnit: 4, tempoChanges: STEPPED },
  },
  {
    name: 'beats against a stepped tempo map',
    kind: 'beats', beats: 10,
    ctx: { bpm: 120, ppqn: 960, tempoChanges: STEPPED },
  },
  {
    name: 'seconds against a stepped tempo map',
    kind: 'seconds', seconds: 5,
    ctx: { bpm: 120, ppqn: 960, tempoChanges: STEPPED },
  },
  {
    name: 'bars against a ramped tempo map',
    kind: 'bars', bar: 3, beat: 3, tick: 0,
    ctx: { bpm: 90, ppqn: 960, beatsPerBar: 4, beatUnit: 4, tempoChanges: RAMPED },
  },
];

const EASING_PROBES = [-0.5, 0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, 1.5];

const LANE_PROBES = [-1, 0, 0.5, 1, 1.5, 2, 3, 4, 5];

const LANE_INPUTS: Array<Omit<LaneCase, 'samples' | 'exact'>> = [
  {
    name: 'linear ramp, held after the end',
    startBeats: 2, endBeats: 6, from: 0, to: 1, shape: 'linear',
    points: null, chase: true, hold: true, invert: false, bpm: 120,
  },
  {
    name: 'linear ramp, not held, so it stops writing',
    startBeats: 2, endBeats: 6, from: 0, to: 1, shape: 'linear',
    points: null, chase: true, hold: false, invert: false, bpm: 120,
  },
  {
    name: 'descending range',
    startBeats: 0, endBeats: 8, from: 1, to: 0.25, shape: 'linear',
    points: null, chase: true, hold: true, invert: false, bpm: 120,
  },
  {
    name: 'inverted, which mirrors within the range rather than reversing time',
    startBeats: 0, endBeats: 8, from: 0.2, to: 0.8, shape: 'linear',
    points: null, chase: true, hold: true, invert: true, bpm: 120,
  },
  {
    name: 'sCurve shape',
    startBeats: 0, endBeats: 8, from: 0, to: 1, shape: 'sCurve',
    points: null, chase: true, hold: true, invert: false, bpm: 120,
  },
  {
    name: 'swell shape, which is not monotonic',
    startBeats: 0, endBeats: 8, from: 0, to: 1, shape: 'swell',
    points: null, chase: true, hold: true, invert: false, bpm: 120,
  },
  {
    name: 'baked points override shape, from and to',
    startBeats: 0, endBeats: 8, from: 99, to: -99, shape: 'exp',
    points: [
      { t: 0, value: 10 },
      { t: 0.25, value: 40 },
      { t: 0.75, value: 20 },
      { t: 1, value: 80 },
    ],
    chase: true, hold: true, invert: false, bpm: 120,
  },
  {
    name: 'a zero-length range never writes',
    startBeats: 4, endBeats: 4, from: 0, to: 1, shape: 'linear',
    points: null, chase: true, hold: true, invert: false, bpm: 120,
  },
  {
    name: 'a backwards range never writes',
    startBeats: 6, endBeats: 2, from: 0, to: 1, shape: 'linear',
    points: null, chase: true, hold: true, invert: false, bpm: 120,
  },
];

const LERP_INPUTS: Array<Omit<LerpCase, 'probes'> & { at: number[] }> = [
  {
    name: 'empty',
    points: [],
    at: [0, 0.5, 1],
  },
  {
    name: 'one point holds everywhere',
    points: [{ t: 0.5, value: 7 }],
    at: [0, 0.5, 1],
  },
  {
    name: 'before the first and after the last clamp',
    points: [
      { t: 0.25, value: 10 },
      { t: 0.75, value: 30 },
    ],
    at: [0, 0.25, 0.5, 0.75, 1],
  },
  {
    name: 'two points at the same t do not divide by zero',
    points: [
      { t: 0.5, value: 10 },
      { t: 0.5, value: 90 },
    ],
    at: [0.25, 0.5, 0.75],
  },
  {
    name: 'a longer curve',
    points: [
      { t: 0, value: 0 },
      { t: 0.2, value: 100 },
      { t: 0.4, value: 25 },
      { t: 1, value: 60 },
    ],
    at: [0, 0.1, 0.2, 0.3, 0.4, 0.7, 1],
  },
];

const DISPLAY_INPUTS: Array<[number, number, number]> = [
  [0, 0, 1], [64, 0, 1], [127, 0, 1],
  [0, 20, 20000], [64, 20, 20000], [127, 20, 20000],
  [64, -1, 1], [0, 100, 0],
];

const TRANSCENDENTAL_EASINGS = new Set<string>(['exp', 'log', 'swell']);

export function sessionFixtureStamp(
  fixture: Omit<SessionConformanceFixture, 'stamp'> & { stamp?: string },
): string {
  const body = JSON.stringify([
    fixture.version,
    fixture.tolerance,
    fixture.signatures,
    fixture.positions,
    fixture.easings,
    fixture.lanes,
    fixture.lerps,
    fixture.display127,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A context from the fixture's own description of one.
 *
 * The tempo map is rebuilt from `tempoChanges` rather than carried as an
 * object, so the other implementation constructs its own from the same list
 * and the construction itself is part of what agrees. A change at beat 0 is
 * the base tempo, which is the rule `TempoMap` already applies.
 */
function contextFor(ctx: PositionCase['ctx']): TimeContext {
  const changes = ctx.tempoChanges;
  const base = changes?.find((change) => change.atBeat === 0);
  const map = changes
    ? new TempoMap(
        changes
          .filter((change) => change.atBeat > 0)
          .map((change) => ({
            atBeat: change.atBeat,
            bpm: change.bpm,
            curve: change.curve === 'ramp' ? ('ramp' as const) : ('jump' as const),
          })),
        base?.bpm ?? ctx.bpm,
        base?.curve === 'ramp' ? ('ramp' as const) : ('jump' as const),
      )
    : undefined;
  return {
    bpm: ctx.bpm,
    ppqn: ctx.ppqn,
    beatsPerBar: ctx.beatsPerBar,
    beatUnit: ctx.beatUnit,
    tempoMap: map,
  };
}

/** Lanes are probed at a constant tempo: the shapes are the subject here. */
function laneContext(bpm: number): TimeContext {
  return { bpm, ppqn: 960 };
}

export function buildSessionConformanceFixture(): SessionConformanceFixture {
  const signatures: SignatureCase[] = SIGNATURE_INPUTS.map(([beatsPerBar, beatUnit]) => ({
    beatsPerBar,
    beatUnit,
    normalizedUnit: normalizeBeatUnit(beatUnit ?? undefined),
    signatureBeat: signatureBeatBeats(beatUnit ?? undefined),
    bar: barBeats(beatsPerBar ?? undefined, beatUnit ?? undefined),
  }));

  const positions: PositionCase[] = POSITION_INPUTS.map((entry) => {
    const ctx = contextFor(entry.ctx);
    const value =
      entry.kind === 'seconds'
        ? Time.seconds(entry.seconds!)
        : entry.kind === 'beats'
          ? Time.beats(entry.beats!)
          : Time.bars(entry.bar!, entry.beat!, entry.tick!);
    return {
      ...entry,
      toBeats: value.toBeats(ctx),
      toSeconds: value.toSeconds(ctx),
      // A ramp puts `log` and `exp` in the way; everything else is arithmetic.
      exact: !(ctx.tempoMap?.hasRamps ?? false),
    };
  });

  const easings: EasingCase[] = [];
  for (const name of Object.keys(Easing) as EasingName[]) {
    for (const u of EASING_PROBES) {
      easings.push({ name, u, value: Easing[name](u), exact: !TRANSCENDENTAL_EASINGS.has(name) });
    }
  }

  const lanes: LaneCase[] = LANE_INPUTS.map((entry) => {
    const ctx = laneContext(entry.bpm);
    const lane = new AutomationLane({
      shape: Easing[entry.shape],
      from: entry.from,
      to: entry.to,
      range: { start: Time.beats(entry.startBeats), end: Time.beats(entry.endBeats) },
      points: entry.points ?? undefined,
      chase: entry.chase,
      hold: entry.hold,
      invert: entry.invert,
    });
    return {
      ...entry,
      points: entry.points ? entry.points.map((point) => ({ ...point })) : null,
      samples: LANE_PROBES.map((timelineSec) => ({
        timelineSec,
        value: lane.evaluate(timelineSec, ctx) ?? null,
      })),
      exact: entry.points != null || !TRANSCENDENTAL_EASINGS.has(entry.shape),
    };
  });

  const lerps: LerpCase[] = LERP_INPUTS.map((entry) => ({
    name: entry.name,
    points: entry.points.map((point) => ({ ...point })),
    probes: entry.at.map((t) => ({ t, value: lerpPoints(entry.points, t) })),
  }));

  const display127: Display127Case[] = DISPLAY_INPUTS.map(([raw127, min, max]) => ({
    raw127,
    min,
    max,
    value: mapDisplay127(raw127, min, max),
  }));

  const fixture: Omit<SessionConformanceFixture, 'stamp'> = {
    note: 'Generated by scripts/emit-session-fixtures.ts. Do not edit by hand: run `npm run fixtures:session`.',
    version: SESSION_CONFORMANCE_FIXTURE_VERSION,
    tolerance: SESSION_TRANSCENDENTAL_TOLERANCE,
    signatures,
    positions,
    easings,
    lanes,
    lerps,
    display127,
  };
  return { ...fixture, stamp: sessionFixtureStamp(fixture) };
}
