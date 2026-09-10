import { PITCH_CLASS_NAMES, pitchClass } from './notes';

/**
 * Scales as semitone offsets from the tonic. Everything downstream (key
 * detection, quantizing, spelling a chord in a key) reads these, so a scale
 * is added in one place.
 *
 * The live Quantize material only exposes five of these as an index:
 * major, minor, pentatonicMajor (labeled pentatonic), chromatic, wholeTone.
 * See `QUANTIZE_SCALE_NAMES` in `asl/controlMath.ts`. Dorian and the rest
 * are for analysis and construction, not that node.
 */
export const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
} as const;

export type ScaleName = keyof typeof SCALE_INTERVALS;

/**
 * The seven rotations of the major scale, in rotation order. `detectKey`
 * searches these because they are the modes real music is usually in; the
 * rest of `SCALE_INTERVALS` is for construction, not detection.
 */
export const DIATONIC_MODES = [
  'major',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'minor',
  'locrian',
] as const satisfies readonly ScaleName[];

export type DiatonicMode = (typeof DIATONIC_MODES)[number];

export function scaleIntervals(scale: ScaleName): readonly number[] {
  return SCALE_INTERVALS[scale];
}

/** The pitch classes of a scale, sorted ascending from the tonic's class. */
export function scalePitchClasses(root: number, scale: ScaleName): number[] {
  return SCALE_INTERVALS[scale].map((step) => pitchClass(root + step));
}

/** Actual MIDI notes of one octave, starting at `rootMidi`. */
export function scaleNotes(rootMidi: number, scale: ScaleName): number[] {
  return SCALE_INTERVALS[scale].map((step) => rootMidi + step);
}

export function isInScale(midi: number, root: number, scale: ScaleName): boolean {
  return scalePitchClasses(root, scale).includes(pitchClass(midi));
}

/**
 * Snaps to the nearest scale tone, preferring downward on an exact tie so
 * that a run of quantized notes does not wander upward.
 */
export function snapToScale(midi: number, root: number, scale: ScaleName): number {
  const classes = scalePitchClasses(root, scale);
  const target = pitchClass(midi);
  let best = 0;
  let bestDistance = Infinity;
  for (const candidate of classes) {
    for (const offset of [-12, 0, 12]) {
      const distance = Math.abs(candidate + offset - target);
      if (distance < bestDistance - 1e-9) {
        bestDistance = distance;
        best = candidate + offset;
      }
    }
  }
  return Math.round(midi) + (best - target);
}

/** `scaleName(0, 'minor')` is "C minor". Display only. */
export function scaleName(root: number, scale: ScaleName): string {
  return `${PITCH_CLASS_NAMES[pitchClass(root)]} ${humanizeScale(scale)}`;
}

function humanizeScale(scale: ScaleName): string {
  switch (scale) {
    case 'harmonicMinor':
      return 'harmonic minor';
    case 'melodicMinor':
      return 'melodic minor';
    case 'pentatonicMajor':
      return 'pentatonic major';
    case 'pentatonicMinor':
      return 'pentatonic minor';
    case 'wholeTone':
      return 'whole tone';
    default:
      return scale;
  }
}
