/**
 * Note naming and conversion, with no dependency on the rest
 * of crate: no scene, no context, no audio.
 *
 * MIDI note numbers throughout. 60 is middle C, 69 is A440.
 */

/** Sharp spellings, semitone order. Index is the pitch class. */
export const PITCH_CLASS_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

/** Flat spellings of the same twelve. */
export const PITCH_CLASS_NAMES_FLAT = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
] as const;

export type PitchClassName = (typeof PITCH_CLASS_NAMES)[number];

export const A4_MIDI = 69;
export const DEFAULT_TUNING_HZ = 440;

/** 0..11, correct for negative note numbers too. */
export function pitchClass(midi: number): number {
  const mod = Math.round(midi) % 12;
  return mod < 0 ? mod + 12 : mod;
}

/** Scientific pitch notation octave. Middle C (60) is octave 4. */
export function octaveOf(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

export function noteName(midi: number, options: { flats?: boolean; octave?: boolean } = {}): string {
  const names = options.flats ? PITCH_CLASS_NAMES_FLAT : PITCH_CLASS_NAMES;
  const name = names[pitchClass(midi)]!;
  return options.octave === false ? name : `${name}${octaveOf(midi)}`;
}

/**
 * Parses `C4`, `F#3`, `Bb-1`, `A` (octave defaults to 4). Returns null rather
 * than throwing, because the usual caller is parsing something a person
 * typed and a null is easier to report than an exception is to catch.
 */
export function midiFromName(name: string): number | null {
  const match = /^([A-Ga-g])([#b]*)(-?\d+)?$/.exec(name.trim());
  if (!match) return null;
  const letter = match[1]!.toUpperCase();
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter];
  if (base === undefined) return null;
  let accidental = 0;
  for (const ch of match[2]!) accidental += ch === '#' ? 1 : -1;
  const octave = match[3] === undefined ? 4 : Number(match[3]);
  return (octave + 1) * 12 + base + accidental;
}

export function midiToFrequency(midi: number, tuningHz = DEFAULT_TUNING_HZ): number {
  return tuningHz * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Fractional, so a caller can see how far off a note a pitch actually is. */
export function frequencyToMidi(hz: number, tuningHz = DEFAULT_TUNING_HZ): number {
  if (!(hz > 0)) return Number.NaN;
  return A4_MIDI + 12 * Math.log2(hz / tuningHz);
}

/**
 * Cents from the nearest equal-tempered note, in [-50, 50). Fractional
 * rather than rounded, so a pitch between two notes is reported as cents
 * off rather than as the nearest note.
 */
export function centsOffPitch(hz: number, tuningHz = DEFAULT_TUNING_HZ): number {
  const midi = frequencyToMidi(hz, tuningHz);
  if (Number.isNaN(midi)) return Number.NaN;
  const cents = (midi - Math.round(midi)) * 100;
  return cents === 50 ? -50 : cents;
}

/** Semitone distance, always 0..11, from `a` up to `b`. */
export function intervalBetween(a: number, b: number): number {
  return pitchClass(b - a);
}

export const INTERVAL_NAMES = [
  'unison',
  'minor 2nd',
  'major 2nd',
  'minor 3rd',
  'major 3rd',
  'perfect 4th',
  'tritone',
  'perfect 5th',
  'minor 6th',
  'major 6th',
  'minor 7th',
  'major 7th',
] as const;

export function intervalName(semitones: number): string {
  return INTERVAL_NAMES[pitchClass(semitones)]!;
}

export function transpose(midi: number, semitones: number): number {
  return midi + semitones;
}
