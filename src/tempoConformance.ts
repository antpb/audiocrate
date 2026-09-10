/**
 * The tempo map conformance fixture, as a value.
 *
 * The first slice of the session layer that a native host can actually
 * execute. Everything a scene places is placed in musical time and rendered
 * in seconds, so a host that cannot answer "what second is beat 129.7" cannot
 * place a clip, a warp segment, an automation breakpoint or a loop boundary.
 * `TempoMap` answers it, and until this file existed it answered it in one
 * language only.
 *
 * Two properties this has to protect, both stated in `TempoMap.ts`:
 *
 *  1. **A map with no changes returns exactly the constant-tempo formula.**
 *     Not approximately. `(beats * 60) / bpm` and `beats * (60 / bpm)`
 *     disagree in the last bit at some tempos, so the constant cases here are
 *     compared with no tolerance at all. A port that pre-divides passes an
 *     approximate check and moves every existing clip by a rounding.
 *  2. **The inverse is an inverse.** Round trips are recorded so an inverse
 *     that is subtly not one cannot pass. They are held to
 *     `roundTripTolerance` rather than to the bit: each direction is one
 *     correctly-rounded expression and the composition is two roundings, so
 *     the identity holds exactly only at tempos where the arithmetic happens
 *     to be exact. Building this fixture is what established that, and
 *     `TempoMap.ts` used to claim otherwise.
 *
 * Ramp cases are the one place a tolerance is right: they go through `log` and
 * `exp`, V8 bundles fdlibm and Swift calls Apple's libm, and two correct
 * implementations may disagree in the last bit. Every case carries whether it
 * is exact, so the reader on the other side applies the strict rule where it
 * belongs instead of applying the loose one everywhere.
 */
import { TempoMap, type TempoChange, type TempoCurve } from './TempoMap';

/**
 * Bumped when the shape changes, not when the maths does.
 *
 * 1: maps, queries, round trips, segments.
 */
export const TEMPO_CONFORMANCE_FIXTURE_VERSION = 1;

export interface TempoQueryCase {
  /** Input in beats for beat-domain queries, seconds for `beatAtSeconds`. */
  at: number;
  secondsAtBeat: number;
  bpmAtBeat: number;
  beatAtSeconds: number;
  bpmAtSeconds: number;
}

export interface TempoSpanCase {
  fromBeat: number;
  beats: number;
  seconds: number;
}

export interface TempoSegmentRecord {
  atBeat: number;
  atSeconds: number;
  bpm: number;
  slope: number;
}

export interface TempoMapCase {
  name: string;
  baseBpm: number;
  baseCurve: TempoCurve;
  changes: TempoChange[];
  /**
   * True when every query on this map goes through the plain
   * multiply-and-divide path, so the other implementation is held to the bit.
   */
  exact: boolean;
  isConstant: boolean;
  hasRamps: boolean;
  /** `changes` as the map normalised them: sorted, deduplicated, curve resolved. */
  normalisedChanges: TempoChange[];
  segments: TempoSegmentRecord[];
  queries: TempoQueryCase[];
  spans: TempoSpanCase[];
  /** `beatAtSeconds(secondsAtBeat(beat))`, which must come back as `beat`. */
  roundTrips: Array<{ beat: number; back: number }>;
}

export interface TempoConformanceFixture {
  note: string;
  version: number;
  stamp: string;
  /** Deviation allowed on a map that ramps. Constant maps allow none. */
  rampTolerance: number;
  /**
   * Deviation allowed when composing the two directions.
   *
   * Generous next to the few ULP actually observed, and still four orders of
   * magnitude tighter than one sample at 48 kHz, so an inverse that forgot to
   * add its segment's start beat fails by whole beats rather than sneaking
   * under it.
   */
  roundTripTolerance: number;
  maps: TempoMapCase[];
}

export const TEMPO_RAMP_TOLERANCE = 1e-9;
export const TEMPO_ROUND_TRIP_TOLERANCE = 1e-9;

/**
 * Positions every map is asked about.
 *
 * The awkward ones are deliberate. Beat 0 is the origin. A negative beat
 * extrapolates backwards rather than clamping, which is stated behaviour and
 * easy to get wrong by adding a `max(0, ...)`. 129.7 at 174 bpm is the exact
 * pair that exposed the pre-divide rounding difference, so it is kept as a
 * regression probe rather than as a round number.
 */
const PROBE_BEATS = [-4, -0.5, 0, 0.25, 1, 3.5, 4, 7.9999, 8, 12, 16.5, 32, 129.7];

const SPAN_PROBES: Array<[number, number]> = [
  [0, 4],
  [0, 1],
  [2, 2],
  [3.5, 0.5],
  [4, 8],
  [7, 2],
  [0, 0],
  [16, -4],
];

const MAP_INPUTS: Array<{
  name: string;
  baseBpm: number;
  baseCurve?: TempoCurve;
  changes: TempoChange[];
}> = [
  { name: 'constant 120', baseBpm: 120, changes: [] },
  { name: 'constant 174, the pre-divide probe', baseBpm: 174, changes: [] },
  { name: 'constant 90.5, not a whole number', baseBpm: 90.5, changes: [] },
  {
    name: 'one jump at bar 2',
    baseBpm: 120,
    changes: [{ atBeat: 8, bpm: 90 }],
  },
  {
    name: 'three jumps',
    baseBpm: 100,
    changes: [
      { atBeat: 4, bpm: 140 },
      { atBeat: 12, bpm: 80 },
      { atBeat: 20, bpm: 128 },
    ],
  },
  {
    name: 'unsorted input, and a duplicate the later one wins',
    baseBpm: 120,
    changes: [
      { atBeat: 12, bpm: 80 },
      { atBeat: 4, bpm: 999 },
      { atBeat: 4, bpm: 140 },
    ],
  },
  {
    name: 'a change at beat 0 replaces the base tempo',
    baseBpm: 120,
    changes: [
      { atBeat: 0, bpm: 60 },
      { atBeat: 8, bpm: 120 },
    ],
  },
  {
    name: 'accelerando 60 to 120 over four beats',
    baseBpm: 60,
    baseCurve: 'ramp',
    changes: [{ atBeat: 4, bpm: 120 }],
  },
  {
    name: 'ritardando 140 to 70',
    baseBpm: 120,
    changes: [
      { atBeat: 8, bpm: 140, curve: 'ramp' },
      { atBeat: 16, bpm: 70 },
    ],
  },
  {
    name: 'a ramp with nowhere to ramp to holds',
    baseBpm: 120,
    changes: [{ atBeat: 8, bpm: 90, curve: 'ramp' }],
  },
  {
    name: 'ramp then constant then ramp',
    baseBpm: 90,
    changes: [
      { atBeat: 4, bpm: 150, curve: 'jump' },
      { atBeat: 8, bpm: 150, curve: 'ramp' },
      { atBeat: 16, bpm: 75 },
    ],
  },
];

export function tempoFixtureStamp(
  fixture: Omit<TempoConformanceFixture, 'stamp'> & { stamp?: string },
): string {
  const body = JSON.stringify([
    fixture.version,
    fixture.rampTolerance,
    fixture.roundTripTolerance,
    fixture.maps,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildTempoConformanceFixture(): TempoConformanceFixture {
  const maps: TempoMapCase[] = MAP_INPUTS.map((entry) => {
    const map = new TempoMap(entry.changes, entry.baseBpm, entry.baseCurve ?? 'jump');
    const queries: TempoQueryCase[] = PROBE_BEATS.map((at) => ({
      at,
      secondsAtBeat: map.secondsAtBeat(at),
      bpmAtBeat: map.bpmAtBeat(at),
      beatAtSeconds: map.beatAtSeconds(at),
      bpmAtSeconds: map.bpmAtSeconds(at),
    }));
    return {
      name: entry.name,
      baseBpm: entry.baseBpm,
      baseCurve: entry.baseCurve ?? 'jump',
      changes: entry.changes.map((change) => ({ ...change })),
      exact: !map.hasRamps,
      isConstant: map.isConstant,
      hasRamps: map.hasRamps,
      normalisedChanges: map.changes.map((change) => ({ ...change })),
      segments: map.segmentsFromBeat(-1).map((segment) => ({ ...segment })),
      queries,
      spans: SPAN_PROBES.map(([fromBeat, beats]) => ({
        fromBeat,
        beats,
        seconds: map.spanSeconds(fromBeat, beats),
      })),
      roundTrips: PROBE_BEATS.map((beat) => ({
        beat,
        back: map.beatAtSeconds(map.secondsAtBeat(beat)),
      })),
    };
  });

  const fixture: Omit<TempoConformanceFixture, 'stamp'> = {
    note: 'Generated by scripts/emit-tempo-fixtures.ts. Do not edit by hand: run `npm run fixtures:tempo`.',
    version: TEMPO_CONFORMANCE_FIXTURE_VERSION,
    rampTolerance: TEMPO_RAMP_TOLERANCE,
    roundTripTolerance: TEMPO_ROUND_TRIP_TOLERANCE,
    maps,
  };
  return { ...fixture, stamp: tempoFixtureStamp(fixture) };
}
