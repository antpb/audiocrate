# Scenes and time

## The graph

```
AudioScene
├── transport            the playhead and the tempo map
├── master: Bus          everything ends here
└── tracks: Track[]
    ├── clips            audio placed on the timeline
    ├── midiClips        notes placed on the timeline
    ├── instrument       a note-driven source AudioMaterial, at most one
    └── materials        an ordered insert chain
```

A `Track` and a `Bus` are both nodes with a volume, a pan, a mute, and a
AudioMaterial chain. The difference is that a track holds content and a bus does
not.

```ts
import { AudioScene, Track, Clip, Time } from 'audiocrate';

const scene = new AudioScene();
await scene.start();

const drums = scene.addTrack(new Track({ name: 'Drums' }));
drums.volume = 0.8;
drums.pan = -0.2;

drums.addClip(new Clip({ buffer }), { at: Time.bars(1, 1, 0) });
```

## Starting a scene

`AudioScene` does nothing until `start()` resolves:

```ts
const scene = new AudioScene();
scene.transport.play(); // throws SceneNotStartedError
```

Two scenes never share a context, a transport, or a master bus. You can run
several independently.

### Supplying your own context

Browsers only allow an audio context to start inside a user gesture, and on
some platforms an application needs exactly one context for its whole
lifetime. The context is injected:

```ts
const scene = new AudioScene({ createContext: () => myExistingContext });
```

The same seam is what lets the library be tested without a browser, and what
lets an offline renderer exist.

## Time is a value, not a number

`Time` is a structured value that resolves against a tempo map later. "Bar 3
beat 2" means different wall-clock times at different tempos. Flattening to
seconds too early cannot follow a tempo change.

```ts
Time.seconds(1.5)
Time.beats(4)        // quarter-note beats, always
Time.bars(2, 1, 0)   // bar 2, beat 1, tick 0. Bars and beats are 1-indexed.
time`2:1:0`          // identical to the line above
```

`Time.beats` is quarter notes. `Time.bars` counts signature beats: beat 1
in 6/8 is an eighth, because resolution uses `beatsPerBar` and `beatUnit`
from the context. Absent `beatUnit` means 4. See [the time signature
rule](asl.md#time-signature-is-two-numbers).

Everything is validated at construction. A non-integer bar, a beat outside
the signature, a fourth argument to `bars`: all throw immediately.

Resolution happens against an explicit context, never a hidden global:

```ts
scene.transport.bpm = 128;
scene.transport.beatsPerBar = 6;
scene.transport.beatUnit = 8;
scene.publishTransport();
const seconds = scene.transport.resolve(Time.bars(2, 1, 0));
```

### Tempo over time

A song that changes tempo needs a map. A map is a pure conversion between
beats and seconds with no reference to a clock, a transport, or a scene.

```ts
scene.transport.tempoMap = new TempoMap([{ atBeat: 32, bpm: 90 }], 120);

scene.transport.currentBpm;    // tempo where the playhead is
scene.transport.positionBeats; // the playhead, in beats
scene.transport.bpmAt(12.5);   // tempo at a point in seconds
```

Maps are immutable: `withChange` and `withoutChange` return new ones.

A change can hold its tempo until the next one, or ramp to it:

```ts
new TempoMap(
  [
    { atBeat: 0, bpm: 60, curve: 'ramp' },   // accelerate from here
    { atBeat: 16, bpm: 120 },                // to here, then hold
  ],
  60,
);
```

The curve belongs to the span that **starts** at the change. A ramp with
nothing after it holds.

**A ramp is integrated, not averaged.** Averaging the two tempos is wrong:
the slow end of a ramp lasts longer than the fast end. Four beats
accelerating from 60 to 120 take 2.77 seconds, not the 2.67 an average
gives. The difference is a tenth of a second by the end of one bar, and it
compounds.

**A tempo map changes what second a musical position falls on, and nothing
else.** Scheduling stays what it was: one origin captured after the graph is
built, and every track offset from it by its own latency compensation. The
map is consulted before any of that, when a `Time` becomes seconds.

- **A clip placed in seconds does not move.** A tempo map is about musical
  positions.
- **A constant span stays on the constant path**, even in a map that ramps
  elsewhere. Adding a ramp in bar 30 does not move bar 2.
- **A scene with no map schedules as it did before maps existed.**
  `Time.toSeconds` takes the same branch. The constant case matches the
  original formula to the last bit.

A tempo change also reaches the audio thread, so a synced effect follows it
on the sample it lands on. See [the transport nodes](asl.md#the-transport).

### In a project file

A project carries its map as an optional `tempoChanges` array beside `bpm`:

```json
{
  "bpm": 120,
  "tempoChanges": [{ "atBeat": 16, "bpm": 140, "curve": "ramp" }]
}
```

```ts
const { map, changes, skipped } = readProjectTempoMap(project);
writeProjectTempoMap(project, scene.transport.tempoMap);
```

- **`bpm` stays authoritative for the tempo the song starts at.** A reader
  that knows nothing about `tempoChanges` still opens the project at the
  right tempo.
- **A constant map writes no field at all**, not an empty array, so a song
  that does not change tempo produces the same file it did before this
  existed.
- **A malformed entry is skipped and reported, not thrown and not dropped.**
  A project file is data from disk that some other version may have written.

`loadProjectScene` applies the map, and a project with no changes leaves the
transport with no map at all.

## The transport

```ts
scene.transport.play();
scene.transport.pause();
scene.transport.stop();
scene.transport.seek(12.5);

scene.transport.position;   // the playhead, in seconds
scene.currentTime;          // the audio clock, in seconds
```

Those last two are different. `transport.position` is the playhead.
`scene.currentTime` is the audio hardware clock. They advance together
during playback. Scheduling against the playhead is wrong. Displaying the
audio clock as a playhead is wrong.

### One origin, always

`play()` builds the whole graph, then captures **one** origin, then starts
everything against it.

If each track is set up in turn and the clock is read as you go, every track
starts at a slightly different time. The drift is proportional to how much
setup happened in between.

The rule: build everything, await everything, then read the clock once.

### The musical position reaches the graph

Play, pause, seek, and tempo all publish an anchor to every live voice, so a
AudioMaterial's graph can read where the song is. See [the transport
nodes](asl.md#the-transport).

```ts
scene.transport.bpm = 120;
scene.transport.beatsPerBar = 4;  // numerator
scene.transport.beatUnit = 4;     // denominator. 8 is 6/8, 2 is 2/2
scene.publishTransport();         // required after changing the signature

scene.transport.onTransportChange((anchor) => { /* ... */ });
scene.transport.anchor;
```

`bpm` is quarter-note tempo. The signature is those two fields, not a
folded bpm.

An anchor is a musical position pinned to a moment on the audio clock, not a
stream of positions. It is published on change and the audio thread derives
every block from its own clock. A voice created mid-song is told where the
song is, the same way automation chases on start.

### Plugin delay compensation

An effect that needs to look ahead introduces latency. If one track has one
and another does not, they drift apart. Audiocrate computes the chain latency of
every track, takes the largest, and delays everything else to match. A track
whose inserts are all latency-free reports zero and is not delayed.

## Clips

A `Clip` wraps a buffer and carries everything about how that buffer appears
on the timeline:

```ts
new Clip({
  buffer,
  region: { startSec: 0.5, endSec: 3.0 },  // trim, in file time
  gainDb: -3,
  fadeInSec: 0.01,
  fadeOutSec: 0.05,
  fadeInCurve: 'equalPower',
});
```

Two kinds of time appear here. `region` is **file time**: which part of the
recording. `at` on `addClip` is **timeline time**: where it sits in the
arrangement. Trimming the start of a clip does not move it, and moving a
clip does not change what part of the file plays.

### Stretching and warping

A clip can be stretched by a ratio, or warped with markers that map file
time to timeline time non-linearly.

```ts
new Clip({ buffer, stretchRatio: 1.5 });
new Clip({ buffer, warpSegments: [/* ... */] });
```

**Never both.** Warp replaces stretch. When warp segments are present, the
stretch ratio is ignored.

### Crossfades

Adjacent clips on a track can crossfade. Audiocrate computes the overlaps from
clip positions rather than requiring fade objects placed by hand.

## Automation

A lane is a set of points with a shape between them.

```ts
track.automate('volume', lane);
```

Five shapes are available: linear, exponential, logarithmic, hold, and
smooth. Two behaviours:

- **Chase on start.** Beginning playback in the middle of a lane applies the
  value that lane had at that point, rather than waiting for the next point.
- **Hold past the end.** A lane's last value persists rather than snapping
  back to a default.

## Rendering offline

The same scene and the same AudioMaterials render without an audio context:

```ts
import { OfflineRenderer } from 'audiocrate/testing';

const { samples, sampleRate } = OfflineRenderer.render(material.graph, {
  duration: 2,
  params: { note: 69, velocity: 1 },
  noteOffAt: 1.5,
});
```

This is the same evaluator the real-time path uses, not a second
implementation. Automated regression testing of DSP is: render a graph,
compare it against a stored reference, fail if it moved.

## Loading

| Loader | Handles |
|---|---|
| `AudioLoader` | Uncompressed audio files, integer and floating point |
| `IRLoader` | Impulse responses, returning them ready for the convolution AudioMaterial |
| `MidiLoader` | Standard MIDI files, type 0 and type 1 |
| `ProjectLoader` | A project directory into a live scene |
| `ProjectExporter` | A scene back out to a project directory |

`ProjectLoader` takes an optional file reader, so it can either build a
lightweight reference-only scene or fully decode every clip, depending on
what you hand it.

A project file may store `bpm`, `timeSigN`, and `timeSigD`. The loader
writes those onto `scene.transport` as `bpm`, `beatsPerBar`, and
`beatUnit`.

## What is missing

- **Compressed audio formats.** Uncompressed decoding is built. Compressed
  formats are not.
- **A published inspector component.** Audiocrate ships the model a control panel
  is built from (`describeAudioMaterial`). It does not ship the component.
- **Stereo clips through the AudioMaterial chain are mono-summed at the insert
  input.** Stereo processing inside an AudioMaterial works; the clip-to-insert
  path still needs finishing.
