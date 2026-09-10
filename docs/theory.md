# Theory

Notes, scales, chords, keys, and audio to notes.

```ts
import { detectKey, detectChord, pitchTrack, noteName } from 'audiocrate/theory';

detectChord([60, 64, 67, 71]);        // { symbol: 'Cmaj7', quality: 'maj7', ... }
detectKey(midiNotes);                  // { rootName: 'D', mode: 'dorian', confidence: 0.82 }
pitchTrack(samples, 44100);            // note events from a monophonic recording
```

## Standalone

Nothing here touches a scene, an audio context, a renderer, or the audio
thread. Note numbers in, note numbers out.

This is importable on its own, and nothing else in crate imports it.

## Notes

MIDI note numbers throughout: 60 is middle C, 69 is A440.

```ts
noteName(61);                  // 'C#4'
noteName(61, { flats: true }); // 'Db4'
midiFromName('Bb3');           // 58
midiToFrequency(69);           // 440
frequencyToMidi(444);          // 69.157, fractional on purpose
centsOffPitch(444);            // 15.67
```

`frequencyToMidi` returns a fraction rather than rounding, which is what
makes a tuner possible. Rounding at conversion discards the cents offset.

Tuning is a parameter, not a constant: `midiToFrequency(69, 432)` is 432.

## Scales

Fourteen scales as semitone offsets, including all seven diatonic modes.

```ts
scaleNotes(60, 'minor');            // [60, 62, 63, 65, 67, 68, 70]
isInScale(61, 0, 'major');          // false
snapToScale(61, 0, 'major');        // 60
scaleName(7, 'pentatonicMajor');    // 'G pentatonic major'
```

`snapToScale` works across octave boundaries rather than folding into one
octave, so quantizing a melody keeps its contour instead of collapsing it
into a single register.

## Chords

Twenty-two qualities, from a power chord to a thirteenth.

```ts
detectChord([64, 67, 72]);
// { root: 0, symbol: 'C/E', quality: 'maj', bass: 4, inversion: 1, confidence: 1 }
```

**A template only matches if every one of its notes is present.** Scoring
partial matches names a chord that is not in the set. A chord missing its
third is a different chord.

**A larger template that fits beats a smaller one plus leftovers.** Without
that, every seventh chord gets named as the triad inside it with a stray
note, because the triad matches perfectly and the seventh only matches
exactly.

Inversions come back as a slash symbol and an inversion number. Doubled
octaves are ignored: a chord is a set of pitch classes, and voicing is a
separate question.

`detectChord` returns null below two distinct pitch classes. One note is
not a chord.

## Keys

```ts
const key = detectKey(notes);
key.rootName;      // 'A'
key.mode;          // 'minor'
key.confidence;    // how well the notes fit the winning key
key.margin;        // how far ahead of the runner-up
key.alternatives;  // the top six, scored
```

Notes may be bare MIDI numbers, or carry a duration:

```ts
detectKey([{ midi: 65, durationSec: 8 }, { midi: 60, durationSec: 0.25 }]);
```

Weighting by duration is on whenever durations exist. A note held for two
bars and a passing sixteenth are not the same evidence if counted equally.

### Confidence and margin are different questions

**Confidence** is how well the notes fit the winning key. Low means a poor
fit to every candidate.

**Margin** is how far ahead of second place. Low means two keys score
nearly equally.

High confidence with a low margin: the notes fit A minor and C major about
as well as each other.

### How it decides

Each candidate key is scored by correlating the material's pitch class
histogram against a profile for that key.

Every mode's profile is built the same way: each of its degrees takes the
weight the major profile gives that degree number, and everything outside
the mode takes the off-key average.

Rotating the major profile so the mode's tonic sits first does not work.
Rotating moves the relative major's tonic weight onto some other degree: in
dorian it lands on the flat seventh, so the profile claims the flat seventh
matters nearly as much as the tonic. Assigning by degree number keeps an
ordering of scale degree, which carries across modes.

### Ties

A melody with no sixth cannot distinguish minor from dorian. The two scales
differ by exactly that note, and if it is never played, scoring cannot
separate them.

Audiocrate applies a small fixed preference toward a listed mode order (major,
minor, mixolydian, dorian, lydian, phrygian, locrian). It settles a tie. It
does not overturn an actual note. Include the sixth and the answer changes.

You can narrow the search:

```ts
detectKey(notes, { modes: ['major', 'minor'] });
```

### Diatonic chords

```ts
diatonicTriads(0, SCALE_INTERVALS.major);
// C, Dm, Em, F, G, Am, Bdim
```

## Audio to notes

```ts
const notes = pitchTrack(samples, sampleRate);
// [{ midi: 69, startSec: 0, endSec: 0.5, hz: 440.02, centsOff: 0.1, confidence: 1 }]
```

Monophonic. It runs on the main thread over a buffer, and it is not real
time: a window is the smallest thing that has a pitch at all, so there is
nothing per-sample to express. See [the ASL guide](asl.md) for how a window
gets off the audio thread.

`pitchFrames` gives the per-window detections before any grouping, when you
want to draw a pitch curve rather than a piano roll.

**Notes are grouped by note number, not by frequency.** A continuous pitch
glide produces frames that drift tens of cents. Grouping on frequency
splits one note into several. Grouping on the rounded note keeps it one
event and reports the drift as `centsOff`.

The two halves compose:

```ts
const key = detectKey(
  pitchTrack(samples, sampleRate).map((n) => ({
    midi: n.midi,
    durationSec: n.endSec - n.startSec,
  })),
);
```

## What is missing

- **Polyphonic transcription.** `pitchTrack` is monophonic. Separating
  simultaneous pitches out of one signal is a different problem with
  different methods, not a parameter on this one.
- **Chord progression over time.** `detectChord` names one simultaneity.
  Segmenting a performance into a chord chart means deciding where chords
  change.
- **Enharmonic spelling.** Everything is spelled with sharps unless you ask
  for flats. Spelling Bb vs A# from the key is not wired through yet.
- **Non-diatonic key detection.** The search covers the seven diatonic
  modes. Harmonic minor, and anything modal outside that set, is out of
  scope as written.
- **Tempo and meter.** No beat tracking, no downbeat detection.
