/**
 * music theory utilities, standalone.
 *
 * Nothing in here touches a scene, a context, a renderer or the audio thread.
 * It is note numbers in and note numbers out, which is what makes it usable
 * by someone who never creates an `AudioScene` at all.
 */
export {
  PITCH_CLASS_NAMES,
  PITCH_CLASS_NAMES_FLAT,
  INTERVAL_NAMES,
  A4_MIDI,
  DEFAULT_TUNING_HZ,
  pitchClass,
  octaveOf,
  noteName,
  midiFromName,
  midiToFrequency,
  frequencyToMidi,
  centsOffPitch,
  intervalBetween,
  intervalName,
  transpose,
  type PitchClassName,
} from './notes';

export {
  SCALE_INTERVALS,
  DIATONIC_MODES,
  scaleIntervals,
  scalePitchClasses,
  scaleNotes,
  isInScale,
  snapToScale,
  scaleName,
  type ScaleName,
  type DiatonicMode,
} from './scales';

export {
  CHORD_QUALITIES,
  chordSymbol,
  chordNotes,
  detectChord,
  diatonicTriads,
  type ChordQuality,
  type ChordDetection,
} from './chords';

export {
  MAJOR_KEY_PROFILE,
  DEGREE_WEIGHTS,
  NON_SCALE_WEIGHT,
  detectKey,
  pitchClassHistogram,
  type KeyDetection,
  type TheoryNote,
  type DetectKeyOptions,
} from './key';

export {
  pitchTrack,
  pitchFrames,
  type NoteEvent,
  type PitchFrame,
  type PitchTrackOptions,
} from './pitchTrack';
