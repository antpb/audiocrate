import { PITCH_CLASS_NAMES, pitchClass } from './notes';
import { DIATONIC_MODES, SCALE_INTERVALS, type DiatonicMode } from './scales';

/**
 * A note with as much or as little detail as the caller has. `detectKey`
 * takes bare MIDI numbers or these; a note that was held for two bars should
 * count for more than a passing sixteenth, and duration is how it says so.
 */
export interface TheoryNote {
  readonly midi: number;
  readonly durationSec?: number;
  readonly velocity?: number;
}

export interface KeyDetection {
  /** Pitch class 0..11. */
  readonly root: number;
  readonly rootName: string;
  readonly mode: DiatonicMode;
  /** `D dorian`. */
  readonly name: string;
  /**
   * How well the material fits this key, 0..1. High confidence with a low
   * `margin` means the notes are clearly tonal and clearly ambiguous about
   * which of two related keys they are in, which is a thing that
   * happens.
   */
  readonly confidence: number;
  /** Lead over the runner-up. Near zero means a coin flip. */
  readonly margin: number;
  /** Every candidate, best first. */
  readonly alternatives: readonly { root: number; mode: DiatonicMode; score: number }[];
}

/**
 * Weight per pitch class for a major key, from the published
 * probe-tone experiments. Index 0 is the tonic.
 */
export const MAJOR_KEY_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
] as const;

/**
 * The major profile's weight for each scale degree, first through seventh.
 * Reading it off the profile rather than restating it keeps one source.
 */
export const DEGREE_WEIGHTS = SCALE_INTERVALS.major.map((step) => MAJOR_KEY_PROFILE[step]!);

/** What the major profile gives a note outside the key, averaged. */
export const NON_SCALE_WEIGHT =
  [1, 3, 6, 8, 10].reduce((sum, i) => sum + MAJOR_KEY_PROFILE[i]!, 0) / 5;

/**
 * Every mode's profile is built the same way: each of its degrees takes the
 * weight the major profile gives that degree number, and everything outside
 * the mode takes the off-key average.
 *
 * The obvious construction, rotating the major profile so the mode's tonic
 * lands at index 0, does not work, and it is worth saying why. Rotating puts
 * the relative major's very large tonic weight onto some other degree: in
 * dorian it lands on the flat seventh, so the profile claims that C matters
 * nearly as much as D in D dorian. Real dorian music does not behave that
 * way, and the detector duly fails to find it.
 *
 * Assigning by degree number keeps what the measured profile actually says,
 * which is an ordering: tonic, then fifth, then third, then fourth, sixth,
 * second, seventh. That ordering is about musical function, and function is
 * the thing that carries across modes.
 */
function profileFor(mode: DiatonicMode): number[] {
  const intervals = SCALE_INTERVALS[mode];
  const out = new Array<number>(12).fill(NON_SCALE_WEIGHT);
  intervals.forEach((step, degree) => {
    out[step % 12] = DEGREE_WEIGHTS[degree]!;
  });
  return out;
}

const MODE_PROFILES: Record<DiatonicMode, number[]> = Object.fromEntries(
  DIATONIC_MODES.map((mode) => [mode, profileFor(mode)]),
) as Record<DiatonicMode, number[]>;

/**
 * Tie-break order when two modes score equally. Two modes can differ by a
 * single degree the notes never play: a melody with no sixth cannot
 * distinguish minor from dorian. The nudge is 0.0025 per rank, small enough
 * that an actual note overturns it.
 */
export const MODE_PRIOR = [
  'major',
  'minor',
  'mixolydian',
  'dorian',
  'lydian',
  'phrygian',
  'locrian',
] as const satisfies readonly DiatonicMode[];

const PRIOR_NUDGE = 0.0025;

function priorRank(mode: DiatonicMode): number {
  const index = MODE_PRIOR.indexOf(mode);
  return index === -1 ? MODE_PRIOR.length : index;
}

export interface DetectKeyOptions {
  /**
   * Modes to consider. Defaults to all seven diatonic modes.
   */
  readonly modes?: readonly DiatonicMode[];
  /** Weight each note by how long it sounds. On by default when durations exist. */
  readonly weightByDuration?: boolean;
}

/**
 * The weighted pitch class histogram a key detection is computed from.
 * Exposed because it is genuinely useful on its own: it is what a
 * pitch-class wheel draws.
 */
export function pitchClassHistogram(
  notes: readonly (number | TheoryNote)[],
  options: DetectKeyOptions = {},
): number[] {
  const bins = new Array<number>(12).fill(0);
  for (const entry of notes) {
    if (typeof entry === 'number') {
      bins[pitchClass(entry)] += 1;
      continue;
    }
    const useDuration = options.weightByDuration ?? true;
    const duration = useDuration ? (entry.durationSec ?? 1) : 1;
    // A zero-length note still happened. Counting it as nothing would let a
    // note-on with no matching note-off silently vanish from the analysis.
    bins[pitchClass(entry.midi)] += Math.max(duration, 1e-3);
  }
  return bins;
}

/**
 * Names the key of a set of notes.
 *
 * Returns null for nothing to go on. Two notes are not a key, and a
 * confident answer from two notes would be worse than no answer.
 */
export function detectKey(
  notes: readonly (number | TheoryNote)[],
  options: DetectKeyOptions = {},
): KeyDetection | null {
  const histogram = pitchClassHistogram(notes, options);
  const total = histogram.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const distinct = histogram.filter((value) => value > 0).length;
  if (distinct < 3) return null;

  const modes = options.modes ?? DIATONIC_MODES;
  const scored: { root: number; mode: DiatonicMode; score: number }[] = [];

  for (const mode of modes) {
    const profile = MODE_PROFILES[mode];
    for (let root = 0; root < 12; root++) {
      const rotated = histogram.map((_, i) => histogram[(i + root) % 12]!);
      scored.push({
        root,
        mode,
        score: correlation(rotated, profile) - priorRank(mode) * PRIOR_NUDGE,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const second = scored[1];

  return {
    root: best.root,
    rootName: PITCH_CLASS_NAMES[best.root]!,
    mode: best.mode,
    name: `${PITCH_CLASS_NAMES[best.root]} ${best.mode}`,
    confidence: Math.max(0, Math.min(1, best.score)),
    margin: second ? Math.max(0, best.score - second.score) : 1,
    alternatives: scored.slice(0, 6),
  };
}

/** Pearson correlation. Returns 0 when either side is flat, not NaN. */
function correlation(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i]!;
    meanB += b[i]!;
  }
  meanA /= n;
  meanB /= n;

  let num = 0;
  let devA = 0;
  let devB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    num += da * db;
    devA += da * da;
    devB += db * db;
  }
  const denom = Math.sqrt(devA * devB);
  return denom > 1e-12 ? num / denom : 0;
}
