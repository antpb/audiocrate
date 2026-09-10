import { yinPitch } from '../dsp/yin';
import { frequencyToMidi } from './notes';

/**
 * Monophonic audio to note events.
 *
 * This runs on the main thread over a buffer. It is not a graph node and it
 * is not real-time: a window is the smallest unit that has a pitch at all, so
 * there is nothing per-sample to express. See the analysis taps for how a
 * window gets off the audio thread in the first place.
 */

export interface PitchFrame {
  readonly timeSec: number;
  /** Hertz, or 0 when the frame was unvoiced. */
  readonly hz: number;
  /** Fractional MIDI, or NaN when unvoiced. */
  readonly midi: number;
  /** Peak amplitude of the window. */
  readonly level: number;
}

export interface NoteEvent {
  /** Rounded MIDI note number. */
  readonly midi: number;
  readonly startSec: number;
  readonly endSec: number;
  /** Average detected pitch across the note, in hertz. */
  readonly hz: number;
  /** Mean deviation from equal temperament, in cents. */
  readonly centsOff: number;
  /** Fraction of the note's frames that agreed on this pitch, 0..1. */
  readonly confidence: number;
}

export interface PitchTrackOptions {
  readonly windowSize?: number;
  readonly hopSize?: number;
  readonly minHz?: number;
  readonly maxHz?: number;
  /** YIN threshold. Lower is stricter. */
  readonly threshold?: number;
  /** Windows quieter than this are unvoiced. */
  readonly levelFloor?: number;
  /** A note shorter than this is discarded as a detection artefact. */
  readonly minNoteSec?: number;
}

const DEFAULTS = {
  windowSize: 2048,
  hopSize: 512,
  minHz: 50,
  maxHz: 2000,
  threshold: 0.15,
  levelFloor: 0.005,
  minNoteSec: 0.05,
} as const;

/** Per-window pitch, before any note grouping. */
export function pitchFrames(
  samples: ArrayLike<number>,
  sampleRate: number,
  options: PitchTrackOptions = {},
): PitchFrame[] {
  const windowSize = options.windowSize ?? DEFAULTS.windowSize;
  const hopSize = options.hopSize ?? DEFAULTS.hopSize;
  const levelFloor = options.levelFloor ?? DEFAULTS.levelFloor;
  const frames: PitchFrame[] = [];
  if (samples.length < windowSize) return frames;

  const window = new Float32Array(windowSize);
  for (let start = 0; start + windowSize <= samples.length; start += hopSize) {
    let level = 0;
    for (let i = 0; i < windowSize; i++) {
      const value = samples[start + i]!;
      window[i] = value;
      const magnitude = Math.abs(value);
      if (magnitude > level) level = magnitude;
    }
    const timeSec = start / sampleRate;
    if (level < levelFloor) {
      frames.push({ timeSec, hz: 0, midi: Number.NaN, level });
      continue;
    }
    const hz = yinPitch(window, sampleRate, {
      minHz: options.minHz ?? DEFAULTS.minHz,
      maxHz: options.maxHz ?? DEFAULTS.maxHz,
      threshold: options.threshold ?? DEFAULTS.threshold,
    });
    frames.push(
      hz > 0
        ? { timeSec, hz, midi: frequencyToMidi(hz), level }
        : { timeSec, hz: 0, midi: Number.NaN, level },
    );
  }
  return frames;
}

/**
 * Groups frames into notes: consecutive voiced windows that round to the same
 * note number are one note.
 *
 * Rounding before grouping rather than after is the decision that matters. A
 * singer sliding into a note produces frames that drift several tens of cents
 * across the note, and grouping on raw frequency would split one sung note
 * into four. Grouping on the note number keeps it one note and reports the
 * drift as `centsOff`, which is information rather than fragmentation.
 */
export function pitchTrack(
  samples: ArrayLike<number>,
  sampleRate: number,
  options: PitchTrackOptions = {},
): NoteEvent[] {
  const hopSize = options.hopSize ?? DEFAULTS.hopSize;
  const minNoteSec = options.minNoteSec ?? DEFAULTS.minNoteSec;
  const frameSec = hopSize / sampleRate;
  const frames = pitchFrames(samples, sampleRate, options);

  const notes: NoteEvent[] = [];
  let current: { midi: number; startSec: number; hzSum: number; count: number } | null = null;

  const close = (endSec: number): void => {
    if (!current) return;
    const duration = endSec - current.startSec;
    if (duration >= minNoteSec) {
      const hz = current.hzSum / current.count;
      const exact = frequencyToMidi(hz);
      notes.push({
        midi: current.midi,
        startSec: current.startSec,
        endSec,
        hz,
        centsOff: (exact - current.midi) * 100,
        // Frames that could have been in this note versus frames that were.
        confidence: Math.min(1, current.count / Math.max(1, Math.round(duration / frameSec))),
      });
    }
    current = null;
  };

  for (const frame of frames) {
    if (frame.hz <= 0) {
      close(frame.timeSec);
      continue;
    }
    const midi = Math.round(frame.midi);
    if (current && current.midi === midi) {
      current.hzSum += frame.hz;
      current.count += 1;
      continue;
    }
    close(frame.timeSec);
    current = { midi, startSec: frame.timeSec, hzSum: frame.hz, count: 1 };
  }
  close(frames.length > 0 ? frames[frames.length - 1]!.timeSec + frameSec : 0);

  return notes;
}
