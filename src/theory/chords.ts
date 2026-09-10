import { PITCH_CLASS_NAMES, pitchClass } from './notes';

/**
 * Chord qualities as semitone sets above the root, ordered so that a more
 * specific quality is tried before a subset of itself. The order matters:
 * a major seventh chord also contains a major triad, and a matcher that
 * scored templates in an arbitrary order would call it a triad with a
 * stray note.
 */
export const CHORD_QUALITIES = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '5': [0, 7],
  maj6: [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
  dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  minMaj7: [0, 3, 7, 11],
  dim7: [0, 3, 6, 9],
  halfDim7: [0, 3, 6, 10],
  aug7: [0, 4, 8, 10],
  dom9: [0, 2, 4, 7, 10],
  maj9: [0, 2, 4, 7, 11],
  min9: [0, 2, 3, 7, 10],
  add9: [0, 2, 4, 7],
  dom11: [0, 2, 4, 5, 7, 10],
  dom13: [0, 2, 4, 7, 9, 10],
} as const;

export type ChordQuality = keyof typeof CHORD_QUALITIES;

/** How a quality is written after the root. */
const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  '5': '5',
  maj6: '6',
  min6: 'm6',
  dom7: '7',
  maj7: 'maj7',
  min7: 'm7',
  minMaj7: 'mMaj7',
  dim7: 'dim7',
  halfDim7: 'm7b5',
  aug7: '7#5',
  dom9: '9',
  maj9: 'maj9',
  min9: 'm9',
  add9: 'add9',
  dom11: '11',
  dom13: '13',
};

export interface ChordDetection {
  /** Pitch class 0..11. */
  readonly root: number;
  readonly rootName: string;
  readonly quality: ChordQuality;
  /** `Cmaj7`, `Am`, `G7/B`. */
  readonly symbol: string;
  /** Pitch class of the lowest sounding note. */
  readonly bass: number;
  /** 0 for root position, 1 for first inversion, and so on. */
  readonly inversion: number;
  /** 0..1. 1 means the notes are exactly the template and nothing else. */
  readonly confidence: number;
}

export function chordSymbol(root: number, quality: ChordQuality, bass?: number): string {
  const name = PITCH_CLASS_NAMES[pitchClass(root)]!;
  const base = `${name}${QUALITY_SUFFIX[quality]}`;
  if (bass === undefined || pitchClass(bass) === pitchClass(root)) return base;
  return `${base}/${PITCH_CLASS_NAMES[pitchClass(bass)]}`;
}

/** The MIDI notes of a chord, voiced in root position from `rootMidi`. */
export function chordNotes(rootMidi: number, quality: ChordQuality): number[] {
  return CHORD_QUALITIES[quality].map((step) => rootMidi + step);
}

/**
 * Names a set of sounding notes.
 *
 * A template only counts if **every** one of its notes is present. Extra
 * notes past the template cost a little, so a fuller template that also fits
 * wins over a smaller one plus leftovers. Majority vote is not used: a chord
 * missing its third is a different chord.
 *
 * Returns null for fewer than two distinct pitch classes.
 */
export function detectChord(notes: readonly number[]): ChordDetection | null {
  if (notes.length === 0) return null;
  const classes = [...new Set(notes.map(pitchClass))];
  if (classes.length < 2) return null;

  const bass = pitchClass(Math.min(...notes));
  const present = new Set(classes);

  let best: ChordDetection | null = null;
  let bestScore = -Infinity;

  for (const root of classes) {
    for (const quality of Object.keys(CHORD_QUALITIES) as ChordQuality[]) {
      const template = CHORD_QUALITIES[quality];
      const required = template.map((step) => pitchClass(root + step));
      if (!required.every((pc) => present.has(pc))) continue;

      const extras = classes.length - new Set(required).size;
      // Coverage rewards explaining the notes; the extras penalty is what
      // stops `5` (two notes) from beating `maj7` on a seventh chord.
      const score = required.length / (required.length + extras * 2);

      const inversion = required.indexOf(bass);
      // A root-position reading is the likelier one when everything else ties.
      const tieBreak = (inversion === 0 ? 0.01 : 0) + (root === bass ? 0.005 : 0);

      if (score + tieBreak > bestScore) {
        bestScore = score + tieBreak;
        best = {
          root,
          rootName: PITCH_CLASS_NAMES[root]!,
          quality,
          symbol: chordSymbol(root, quality, bass),
          bass,
          inversion: inversion === -1 ? 0 : inversion,
          confidence: Math.min(1, score),
        };
      }
    }
  }

  return best;
}

/**
 * The diatonic triads of a major or minor key, degree 1 first. What a chord
 * palette is built from, and what tells you a detected chord is borrowed.
 */
export function diatonicTriads(root: number, intervals: readonly number[]): ChordDetection[] {
  const classes = intervals.map((step) => pitchClass(root + step));
  const out: ChordDetection[] = [];
  for (let degree = 0; degree < classes.length; degree++) {
    const triad = [
      classes[degree]!,
      classes[(degree + 2) % classes.length]!,
      classes[(degree + 4) % classes.length]!,
    ];
    const chordRoot = triad[0]!;
    const third = pitchClass(triad[1]! - chordRoot);
    const fifth = pitchClass(triad[2]! - chordRoot);
    const quality: ChordQuality =
      third === 4 && fifth === 7
        ? 'maj'
        : third === 3 && fifth === 7
          ? 'min'
          : third === 3 && fifth === 6
            ? 'dim'
            : third === 4 && fifth === 8
              ? 'aug'
              : third === 5
                ? 'sus4'
                : 'maj';
    out.push({
      root: chordRoot,
      rootName: PITCH_CLASS_NAMES[chordRoot]!,
      quality,
      symbol: chordSymbol(chordRoot, quality),
      bass: chordRoot,
      inversion: 0,
      confidence: 1,
    });
  }
  return out;
}
