import { describe, expect, it } from 'vitest';
import {
  centsOffPitch,
  chordNotes,
  chordSymbol,
  detectChord,
  detectKey,
  diatonicTriads,
  frequencyToMidi,
  intervalName,
  isInScale,
  midiFromName,
  midiToFrequency,
  noteName,
  pitchClass,
  pitchClassHistogram,
  pitchTrack,
  SCALE_INTERVALS,
  scaleNotes,
  scaleName,
  snapToScale,
} from '../../src/theory/index';

describe('notes', () => {
  it('names and parses across octaves', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(61, { flats: true })).toBe('Db4');
    expect(noteName(61, { octave: false })).toBe('C#');
    expect(midiFromName('C4')).toBe(60);
    expect(midiFromName('A4')).toBe(69);
    expect(midiFromName('Db4')).toBe(61);
    expect(midiFromName('C-1')).toBe(0);
  });

  it('defaults a bare letter to octave 4 and rejects nonsense', () => {
    expect(midiFromName('G')).toBe(67);
    expect(midiFromName('H4')).toBeNull();
    expect(midiFromName('')).toBeNull();
  });

  it('round-trips every note through frequency', () => {
    for (let midi = 0; midi <= 127; midi++) {
      expect(frequencyToMidi(midiToFrequency(midi))).toBeCloseTo(midi, 9);
    }
  });

  it('puts A4 at the tuning reference and follows a retune', () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(midiToFrequency(69, 432)).toBe(432);
    expect(midiToFrequency(81)).toBeCloseTo(880, 9);
  });

  it('reports cents off the nearest note, signed', () => {
    expect(centsOffPitch(440)).toBeCloseTo(0, 9);
    expect(centsOffPitch(444)).toBeCloseTo(15.667, 2);
    expect(centsOffPitch(436)).toBeCloseTo(-15.813, 2);
  });

  it('has no opinion about a pitch of zero', () => {
    expect(Number.isNaN(frequencyToMidi(0))).toBe(true);
    expect(Number.isNaN(centsOffPitch(-1))).toBe(true);
  });

  it('keeps pitch classes positive below middle C', () => {
    expect(pitchClass(-1)).toBe(11);
    expect(pitchClass(-13)).toBe(11);
  });

  it('names intervals', () => {
    expect(intervalName(7)).toBe('perfect 5th');
    expect(intervalName(3)).toBe('minor 3rd');
    expect(intervalName(12)).toBe('unison');
  });
});

describe('scales', () => {
  it('builds a scale from a tonic', () => {
    expect(scaleNotes(60, 'major')).toEqual([60, 62, 64, 65, 67, 69, 71]);
    expect(scaleNotes(60, 'minor')).toEqual([60, 62, 63, 65, 67, 68, 70]);
    expect(scaleNotes(60, 'pentatonicMinor')).toEqual([60, 63, 65, 67, 70]);
  });

  it('agrees that every mode is a rotation of the same seven notes', () => {
    const cMajor = new Set(SCALE_INTERVALS.major.map((s) => pitchClass(s)));
    const dDorian = new Set(SCALE_INTERVALS.dorian.map((s) => pitchClass(2 + s)));
    expect([...dDorian].sort((a, b) => a - b)).toEqual([...cMajor].sort((a, b) => a - b));
  });

  it('tests membership by pitch class, not by octave', () => {
    expect(isInScale(64, 0, 'major')).toBe(true);
    expect(isInScale(64 + 12, 0, 'major')).toBe(true);
    expect(isInScale(61, 0, 'major')).toBe(false);
  });

  it('snaps to the nearest scale tone and leaves one already in scale alone', () => {
    expect(snapToScale(61, 0, 'major')).toBe(60);
    expect(snapToScale(66, 0, 'major')).toBe(65);
    expect(snapToScale(64, 0, 'major')).toBe(64);
  });

  it('snaps across an octave boundary rather than folding into one octave', () => {
    expect(snapToScale(73, 0, 'major')).toBe(72);
    expect(snapToScale(48 + 1, 0, 'major')).toBe(48);
  });

  it('names a scale for display', () => {
    expect(scaleName(0, 'minor')).toBe('C minor');
    expect(scaleName(7, 'pentatonicMajor')).toBe('G pentatonic major');
  });
});

describe('detectChord', () => {
  const detect = (names: string[]) => detectChord(names.map((n) => midiFromName(n)!));

  it('names plain triads', () => {
    expect(detect(['C4', 'E4', 'G4'])!.symbol).toBe('C');
    expect(detect(['A3', 'C4', 'E4'])!.symbol).toBe('Am');
    expect(detect(['B3', 'D4', 'F4'])!.symbol).toBe('Bdim');
    expect(detect(['C4', 'E4', 'G#4'])!.symbol).toBe('Caug');
  });

  it('names sevenths, and does not settle for the triad inside them', () => {
    expect(detect(['C4', 'E4', 'G4', 'B4'])!.quality).toBe('maj7');
    expect(detect(['G3', 'B3', 'D4', 'F4'])!.quality).toBe('dom7');
    expect(detect(['D4', 'F4', 'A4', 'C5'])!.quality).toBe('min7');
    expect(detect(['B3', 'D4', 'F4', 'A4'])!.quality).toBe('halfDim7');
  });

  it('names suspensions rather than calling them a wrong triad', () => {
    expect(detect(['C4', 'F4', 'G4'])!.quality).toBe('sus4');
    expect(detect(['C4', 'D4', 'G4'])!.quality).toBe('sus2');
  });

  it('reports an inversion with a slash and the right bass', () => {
    const first = detect(['E3', 'G3', 'C4'])!;
    expect(first.root).toBe(0);
    expect(first.bass).toBe(4);
    expect(first.inversion).toBe(1);
    expect(first.symbol).toBe('C/E');
  });

  it('ignores doubled octaves', () => {
    expect(detect(['C3', 'C4', 'E4', 'G4', 'C5'])!.symbol).toBe('C');
  });

  it('is confident about an exact match and less so with a stray note', () => {
    const clean = detect(['C4', 'E4', 'G4'])!;
    const messy = detect(['C4', 'E4', 'G4', 'C#5'])!;
    expect(clean.confidence).toBe(1);
    expect(messy.confidence).toBeLessThan(clean.confidence);
  });

  it('refuses to name a single note', () => {
    expect(detectChord([60])).toBeNull();
    expect(detectChord([60, 72])).toBeNull();
    expect(detectChord([])).toBeNull();
  });

  it('round-trips through chordNotes', () => {
    expect(chordNotes(60, 'min7')).toEqual([60, 63, 67, 70]);
    expect(detectChord(chordNotes(60, 'min7'))!.quality).toBe('min7');
    expect(chordSymbol(9, 'min7')).toBe('Am7');
  });
});

describe('diatonicTriads', () => {
  it('gives the familiar qualities of a major key', () => {
    const triads = diatonicTriads(0, SCALE_INTERVALS.major);
    expect(triads.map((t) => t.symbol)).toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
  });

  it('gives the familiar qualities of a natural minor key', () => {
    const triads = diatonicTriads(9, SCALE_INTERVALS.minor);
    expect(triads.map((t) => t.symbol)).toEqual(['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']);
  });
});

describe('detectKey', () => {
  const notes = (names: string[]) => names.map((n) => midiFromName(n)!);

  it('finds a major key from its scale', () => {
    const key = detectKey(notes(['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5', 'G4', 'C4']))!;
    expect(key.rootName).toBe('C');
    expect(key.mode).toBe('major');
    expect(key.confidence).toBeGreaterThan(0.7);
  });

  it('separates a minor key from its relative major by which note is home', () => {
    // Same seven pitch classes as C major. Only the emphasis differs.
    const key = detectKey(
      notes(['A3', 'C4', 'E4', 'A4', 'G4', 'F4', 'E4', 'A3', 'B3', 'C4', 'A3', 'E4', 'F4', 'A3']),
    )!;
    expect(key.rootName).toBe('A');
    expect(key.mode).toBe('minor');
  });

  it('finds a mode that is neither major nor minor', () => {
    // D dorian: the C major set, resting on D, with B natural doing the work.
    const key = detectKey(
      notes(['D4', 'F4', 'A4', 'D4', 'B4', 'A4', 'D4', 'C5', 'D4', 'F4', 'D4', 'A4', 'B4', 'D4']),
    )!;
    expect(key.rootName).toBe('D');
    expect(key.mode).toBe('dorian');
  });

  it('weights a long note more than a passing one', () => {
    // Every pitch class of C major appears once, but F is held for bars.
    const held = [
      { midi: 65, durationSec: 8 },
      { midi: 60, durationSec: 0.25 },
      { midi: 62, durationSec: 0.25 },
      { midi: 64, durationSec: 0.25 },
      { midi: 67, durationSec: 2 },
      { midi: 69, durationSec: 0.25 },
      { midi: 71, durationSec: 0.25 },
      { midi: 72, durationSec: 2 },
    ];
    const weighted = detectKey(held)!;
    const unweighted = detectKey(held, { weightByDuration: false })!;
    expect(weighted.rootName).toBe('F');
    expect(unweighted.rootName).not.toBe('F');
  });

  it('answers minor rather than dorian when nothing distinguishes them', () => {
    // No sixth anywhere, so minor and dorian describe this equally well.
    // The commoner answer is the better one to give.
    const key = detectKey(notes(['A3', 'C4', 'E4', 'A4', 'G4', 'B3', 'A3', 'E4', 'A3', 'C4']))!;
    expect(key.rootName).toBe('A');
    expect(key.mode).toBe('minor');
    expect(key.margin).toBeLessThan(0.01);
  });

  it('lets real evidence overturn that preference', () => {
    // The same shape with the natural sixth present is dorian, and the tiny
    // nudge toward minor must not be able to outvote an actual note.
    const key = detectKey(
      notes(['D4', 'F4', 'A4', 'D4', 'B4', 'A4', 'D4', 'C5', 'D4', 'B4', 'F4', 'D4']),
    )!;
    expect(key.mode).toBe('dorian');
    expect(key.margin).toBeGreaterThan(0.01);
  });

  it('can be told which modes to consider', () => {
    const key = detectKey(notes(['D4', 'F4', 'A4', 'D4', 'B4', 'C5', 'D4']), {
      modes: ['major', 'minor'],
    })!;
    expect(['major', 'minor']).toContain(key.mode);
  });

  it('reports a small margin when two keys really are close', () => {
    const clear = detectKey(notes(['C4', 'E4', 'G4', 'C4', 'G4', 'E4', 'C4', 'F4', 'D4', 'B3']))!;
    // Stacked fifths: no third anywhere, so nothing says which key this is.
    const ambiguous = detectKey(notes(['C4', 'G4', 'D5', 'C4', 'G4', 'D5']))!;
    expect(ambiguous.margin).toBeLessThan(clear.margin);
  });

  it('lists the runners-up', () => {
    const key = detectKey(notes(['C4', 'E4', 'G4', 'B4', 'D4', 'F4', 'A4']))!;
    expect(key.alternatives.length).toBe(6);
    expect(key.alternatives[0]!.score).toBeGreaterThanOrEqual(key.alternatives[1]!.score);
  });

  it('refuses to guess from too little', () => {
    expect(detectKey([])).toBeNull();
    expect(detectKey([60])).toBeNull();
    expect(detectKey([60, 64])).toBeNull();
  });

  it('builds a histogram that folds octaves together', () => {
    const bins = pitchClassHistogram([60, 72, 84, 67]);
    expect(bins[0]).toBe(3);
    expect(bins[7]).toBe(1);
    expect(bins[1]).toBe(0);
  });
});

describe('pitchTrack', () => {
  const sampleRate = 44100;

  function tone(hz: number, seconds: number, amplitude = 0.5): Float32Array {
    const out = new Float32Array(Math.round(sampleRate * seconds));
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude;
    }
    return out;
  }

  function concat(...parts: Float32Array[]): Float32Array {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  it('finds one held note', () => {
    const notes = pitchTrack(tone(440, 0.5), sampleRate);
    expect(notes.length).toBe(1);
    expect(notes[0]!.midi).toBe(69);
    expect(notes[0]!.hz).toBeCloseTo(440, 0);
    expect(Math.abs(notes[0]!.centsOff)).toBeLessThan(10);
  });

  it('separates a melody into notes at the right pitches', () => {
    const midis = pitchTrack(
      concat(tone(261.63, 0.3), tone(329.63, 0.3), tone(392.0, 0.3)),
      sampleRate,
    ).map((n) => n.midi);
    expect(midis).toEqual([60, 64, 67]);
  });

  it('does not invent notes in silence', () => {
    expect(pitchTrack(new Float32Array(sampleRate), sampleRate)).toEqual([]);
  });

  it('splits notes across a gap', () => {
    const notes = pitchTrack(
      concat(tone(440, 0.3), new Float32Array(Math.round(sampleRate * 0.3)), tone(440, 0.3)),
      sampleRate,
    );
    expect(notes.length).toBe(2);
    expect(notes.every((n) => n.midi === 69)).toBe(true);
    expect(notes[1]!.startSec).toBeGreaterThan(notes[0]!.endSec);
  });

  it('discards a blip shorter than the minimum', () => {
    const notes = pitchTrack(tone(440, 0.5), sampleRate, { minNoteSec: 10 });
    expect(notes).toEqual([]);
  });

  it('returns nothing for a buffer smaller than one window', () => {
    expect(pitchTrack(new Float32Array(100), sampleRate)).toEqual([]);
  });

  it('reports the deviation of a note that is deliberately flat', () => {
    // 435 Hz is about 20 cents under A440.
    const notes = pitchTrack(tone(435, 0.5), sampleRate);
    expect(notes[0]!.midi).toBe(69);
    expect(notes[0]!.centsOff).toBeLessThan(-10);
    expect(notes[0]!.centsOff).toBeGreaterThan(-30);
  });

  it('feeds detectKey directly, which is the point of both existing', () => {
    const audio = concat(
      tone(261.63, 0.25),
      tone(329.63, 0.25),
      tone(392.0, 0.25),
      tone(261.63, 0.5),
    );
    const key = detectKey(pitchTrack(audio, sampleRate).map((n) => ({
      midi: n.midi,
      durationSec: n.endSec - n.startSec,
    })));
    expect(key!.rootName).toBe('C');
  });
});
