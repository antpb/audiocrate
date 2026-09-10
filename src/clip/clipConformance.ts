/**
 * The clip placement fixture, as a value.
 *
 * Slice 2 of the session layer. `tempoConformance.ts` answers what second a
 * beat falls on; this answers what a host does with that second: which part of
 * which file to play, when, at what rate, and at what gain.
 *
 * `clipPlaybackWindows` is the whole placement contract in one function. A
 * host calls it with a clip and a playhead and gets back a list of
 * "start this file at this offset, this many seconds from now, at this rate".
 * That is a small enough surface to port and a large enough one to get wrong:
 * warp segments, a playhead landing mid-segment, and the reciprocal between a
 * stretch ratio and a playback rate are each an off-by-one-concept away from
 * a clip that plays the wrong part of the take.
 *
 * `crossfade.ts` is deliberately not here. It rewrites clip drafts to create
 * overlaps, which is an editing operation a native player does not perform.
 *
 * Everything in `region.ts` is add, subtract, multiply, divide, min and max,
 * so those cases are compared **with no tolerance at all**. The fade shapes
 * reach `sin` and `pow`, where V8's bundled fdlibm and Apple's libm are
 * entitled to disagree in the last bit, so those carry `exact: false` and the
 * fixture states the tolerance once.
 */
import {
  clipPlaybackWindows,
  clipTimelineDurationSec,
  resolveTrimEndSec,
  warpSegmentsFromMs,
  type ClipPlaybackWindow,
  type WarpSegment,
} from './region';
import { clipGainLinear, fadeShape } from './fades';

/**
 * Bumped when the shape changes, not when the maths does.
 *
 * 1: windows, durations, trim resolution, warp conversion, fade shapes, gain.
 */
export const CLIP_CONFORMANCE_FIXTURE_VERSION = 1;

/** Deviation allowed where a case reaches `sin` or `pow`. */
export const CLIP_TRANSCENDENTAL_TOLERANCE = 1e-12;

export interface ClipWindowCase {
  name: string;
  offsetSec: number;
  trimStartSec: number;
  trimEndSec: number;
  stretchRatio: number;
  warpSegments: WarpSegment[] | null;
  playheadSec: number;
  windows: ClipPlaybackWindow[];
}

export interface ClipDurationCase {
  name: string;
  trimStartSec: number;
  trimEndSec: number;
  stretchRatio: number;
  warpSegments: WarpSegment[] | null;
  seconds: number;
}

export interface ClipTrimCase {
  name: string;
  trimStartSec: number;
  trimEndSec: number | null;
  bufferDurationSec: number;
  resolved: number;
}

export interface ClipWarpConversionCase {
  name: string;
  raw: Array<{ fileStartMs: number; fileEndMs: number; ratio: number; localOffsetMs: number }> | null;
  segments: WarpSegment[] | null;
}

export interface ClipFadeCase {
  curve: string;
  x: number;
  gain: number;
  /** False where the shape reaches `sin`. */
  exact: boolean;
}

export interface ClipGainCase {
  db: number;
  linear: number;
  /** False where the conversion reaches `pow`. */
  exact: boolean;
}

export interface ClipConformanceFixture {
  note: string;
  version: number;
  stamp: string;
  tolerance: number;
  windows: ClipWindowCase[];
  durations: ClipDurationCase[];
  trims: ClipTrimCase[];
  warpConversions: ClipWarpConversionCase[];
  fades: ClipFadeCase[];
  gains: ClipGainCase[];
}

function warp(
  fileStartSec: number,
  fileEndSec: number,
  ratio: number,
  localOffsetSec: number,
): WarpSegment {
  return { fileStartSec, fileEndSec, ratio, localOffsetSec };
}

/**
 * Two warp segments: the first half at normal speed, the second stretched to
 * double length. A playhead landing inside the second is the case that
 * separates "skip into the file" from "skip into the timeline", because the
 * two differ by the ratio and only one of them is right.
 */
const TWO_SEGMENTS: WarpSegment[] = [warp(0, 2, 1, 0), warp(2, 4, 2, 2)];

const WINDOW_INPUTS: Array<Omit<ClipWindowCase, 'windows'>> = [
  {
    name: 'plain clip at the origin',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 1,
    warpSegments: null, playheadSec: 0,
  },
  {
    name: 'plain clip offset into the timeline',
    offsetSec: 8, trimStartSec: 0, trimEndSec: 4, stretchRatio: 1,
    warpSegments: null, playheadSec: 0,
  },
  {
    name: 'trimmed clip reads from inside the file',
    offsetSec: 0, trimStartSec: 1.5, trimEndSec: 4, stretchRatio: 1,
    warpSegments: null, playheadSec: 0,
  },
  {
    name: 'playhead inside the clip skips into the file',
    offsetSec: 2, trimStartSec: 0, trimEndSec: 4, stretchRatio: 1,
    warpSegments: null, playheadSec: 3,
  },
  {
    name: 'playhead exactly at the clip start',
    offsetSec: 2, trimStartSec: 0, trimEndSec: 4, stretchRatio: 1,
    warpSegments: null, playheadSec: 2,
  },
  {
    name: 'playhead past the clip end yields nothing',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 1,
    warpSegments: null, playheadSec: 9,
  },
  {
    name: 'playhead exactly at the clip end yields nothing',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 1,
    warpSegments: null, playheadSec: 4,
  },
  {
    name: 'stretched to double length, rate is the reciprocal',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 2,
    warpSegments: null, playheadSec: 0,
  },
  {
    name: 'stretched and the playhead is inside it',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 2,
    warpSegments: null, playheadSec: 3,
  },
  {
    name: 'compressed to half length',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 0.5,
    warpSegments: null, playheadSec: 0,
  },
  {
    name: 'warp segments replace the stretch ratio entirely',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 3,
    warpSegments: TWO_SEGMENTS, playheadSec: 0,
  },
  {
    name: 'playhead inside the second warp segment',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 1,
    warpSegments: TWO_SEGMENTS, playheadSec: 3,
  },
  {
    name: 'playhead past the first warp segment drops it',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 1,
    warpSegments: TWO_SEGMENTS, playheadSec: 2,
  },
  {
    name: 'warped clip offset into the timeline, playhead inside',
    offsetSec: 4, trimStartSec: 0, trimEndSec: 4, stretchRatio: 1,
    warpSegments: TWO_SEGMENTS, playheadSec: 5,
  },
  {
    name: 'a zero-length warp segment is skipped, not played',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 1,
    warpSegments: [warp(0, 2, 1, 0), warp(2, 2, 1, 2), warp(2, 4, 1, 2)],
    playheadSec: 0,
  },
  {
    name: 'a nonsense ratio falls back to 1 rather than dividing by it',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 0,
    warpSegments: null, playheadSec: 0,
  },
  {
    name: 'a negative ratio falls back to 1',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: -2,
    warpSegments: null, playheadSec: 0,
  },
  {
    name: 'an empty warp list is not a warp',
    offsetSec: 0, trimStartSec: 0, trimEndSec: 4, stretchRatio: 2,
    warpSegments: [], playheadSec: 0,
  },
  {
    name: 'a backwards trim yields nothing',
    offsetSec: 0, trimStartSec: 3, trimEndSec: 1, stretchRatio: 1,
    warpSegments: null, playheadSec: 0,
  },
];

const DURATION_INPUTS: Array<Omit<ClipDurationCase, 'seconds'>> = [
  { name: 'plain', trimStartSec: 0, trimEndSec: 4, stretchRatio: 1, warpSegments: null },
  { name: 'trimmed', trimStartSec: 1, trimEndSec: 3.5, stretchRatio: 1, warpSegments: null },
  { name: 'stretched', trimStartSec: 0, trimEndSec: 4, stretchRatio: 2, warpSegments: null },
  { name: 'compressed', trimStartSec: 0, trimEndSec: 4, stretchRatio: 0.25, warpSegments: null },
  { name: 'backwards trim is zero, not negative', trimStartSec: 3, trimEndSec: 1, stretchRatio: 1, warpSegments: null },
  { name: 'nonsense ratio', trimStartSec: 0, trimEndSec: 4, stretchRatio: 0, warpSegments: null },
  { name: 'warped, from the last segment', trimStartSec: 0, trimEndSec: 4, stretchRatio: 9, warpSegments: TWO_SEGMENTS },
  { name: 'empty warp list is not a warp', trimStartSec: 0, trimEndSec: 4, stretchRatio: 2, warpSegments: [] },
];

const TRIM_INPUTS: Array<Omit<ClipTrimCase, 'resolved'>> = [
  { name: 'null means the whole file', trimStartSec: 0, trimEndSec: null, bufferDurationSec: 10 },
  { name: 'a valid end is kept', trimStartSec: 1, trimEndSec: 4, bufferDurationSec: 10 },
  { name: 'an end past the file clamps to the file', trimStartSec: 1, trimEndSec: 40, bufferDurationSec: 10 },
  { name: 'an end at the start falls back to the file', trimStartSec: 4, trimEndSec: 4, bufferDurationSec: 10 },
  { name: 'an end before the start falls back to the file', trimStartSec: 4, trimEndSec: 2, bufferDurationSec: 10 },
];

const WARP_CONVERSION_INPUTS: Array<Omit<ClipWarpConversionCase, 'segments'>> = [
  { name: 'null', raw: null },
  { name: 'empty', raw: [] },
  {
    name: 'milliseconds to seconds',
    raw: [
      { fileStartMs: 0, fileEndMs: 2000, ratio: 1, localOffsetMs: 0 },
      { fileStartMs: 2000, fileEndMs: 4000, ratio: 2, localOffsetMs: 2000 },
    ],
  },
  {
    name: 'a nonsense ratio is repaired on the way in',
    raw: [{ fileStartMs: 0, fileEndMs: 1500, ratio: 0, localOffsetMs: 250 }],
  },
];

const FADE_CURVES = ['linear', 'equalPower', 'sCurve', 'notACurve'];
const FADE_PROBES = [-1, 0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, 2];
const GAIN_PROBES = [6, 0, -3, -6, -12, -59.9, -60, -60.1, -120];

export function clipFixtureStamp(
  fixture: Omit<ClipConformanceFixture, 'stamp'> & { stamp?: string },
): string {
  const body = JSON.stringify([
    fixture.version,
    fixture.tolerance,
    fixture.windows,
    fixture.durations,
    fixture.trims,
    fixture.warpConversions,
    fixture.fades,
    fixture.gains,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildClipConformanceFixture(): ClipConformanceFixture {
  const windows: ClipWindowCase[] = WINDOW_INPUTS.map((entry) => ({
    ...entry,
    warpSegments: entry.warpSegments ? entry.warpSegments.map((seg) => ({ ...seg })) : entry.warpSegments,
    windows: clipPlaybackWindows(entry),
  }));

  const durations: ClipDurationCase[] = DURATION_INPUTS.map((entry) => ({
    ...entry,
    warpSegments: entry.warpSegments ? entry.warpSegments.map((seg) => ({ ...seg })) : entry.warpSegments,
    seconds: clipTimelineDurationSec(entry),
  }));

  const trims: ClipTrimCase[] = TRIM_INPUTS.map((entry) => ({
    ...entry,
    resolved: resolveTrimEndSec(
      { trimStartSec: entry.trimStartSec, trimEndSec: entry.trimEndSec },
      entry.bufferDurationSec,
    ),
  }));

  const warpConversions: ClipWarpConversionCase[] = WARP_CONVERSION_INPUTS.map((entry) => ({
    ...entry,
    segments: warpSegmentsFromMs(entry.raw),
  }));

  const fades: ClipFadeCase[] = [];
  for (const curve of FADE_CURVES) {
    for (const x of FADE_PROBES) {
      fades.push({ curve, x, gain: fadeShape(x, curve), exact: curve !== 'equalPower' });
    }
  }

  const gains: ClipGainCase[] = GAIN_PROBES.map((db) => ({
    db,
    linear: clipGainLinear(db),
    // Below the silence floor the answer is a literal 0, not a computed one.
    exact: !(db > -60),
  }));

  const fixture: Omit<ClipConformanceFixture, 'stamp'> = {
    note: 'Generated by scripts/emit-clip-fixtures.ts. Do not edit by hand: run `npm run fixtures:clip`.',
    version: CLIP_CONFORMANCE_FIXTURE_VERSION,
    tolerance: CLIP_TRANSCENDENTAL_TOLERANCE,
    windows,
    durations,
    trims,
    warpConversions,
    fades,
    gains,
  };
  return { ...fixture, stamp: clipFixtureStamp(fixture) };
}
