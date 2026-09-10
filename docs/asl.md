# The Audio Shader Language

ASL is how you describe what a Material does to a signal. It occupies the
same position as a shader language: a small expression language, evaluated
per sample rather than per pixel, fused into a single unit before it runs.

```ts
graph: ({ input, params }) =>
  filter.lowpass(input, { cutoff: params.cutoff }).mul(params.gain)
```

## A graph is data

That expression does not process audio. It builds a plain object describing a
computation. Nothing in it holds a buffer or an audio context.

- The same graph renders in real time and offline, with one evaluator.
- A graph can cross a thread boundary, which is how a Material reaches the
  audio thread without a build step.
- A graph can be stored in a project file and diffed between versions.
- A graph can be inspected. It is an object, so you can print it.

The graph is also **fused**: the whole expression compiles into one unit that
runs per sample. A twelve-operation Material is one unit of work, not twelve
platform nodes.

## Building expressions

Every builder returns a chainable value:

```ts
osc({ freq: 440, type: 'saw' })
  .mul(0.5)
  .add(noise({ color: 'pink' }).mul(0.05))
  .range(-1, 1)
```

Numbers are accepted anywhere a value is, and wrapped automatically.

The categories, with full listings in [the component
library](components.md):

| | |
|---|---|
| **Sources** | Oscillators, noise, wavetables, sample playback, impulses |
| **Filters** | Common responses, in several topologies and slopes |
| **Envelopes** | Attack-decay-sustain-release, extended envelopes, breakpoint curves |
| **Nonlinear** | Saturation, clipping, bit reduction, rectification, waveshaping |
| **Time** | Delay, comb, reverse, pitch shift, granular scheduling, looping |
| **Dynamics** | Compression, expansion, gating, transient shaping |
| **Control** | Clocks, dividers, logic, sequencing, quantizing, randomness, slew |
| **Analysis** | Envelope following, level, onset detection |
| **Routing** | Mixing, selection, pan law |

Control is the largest category.

## Live inputs

A parameter is one number for a whole block. A **port** is a number per sample
per channel: live audio arriving from outside the graph.

```ts
graph: ({ input, audio }) => input.mul(audio.sidechain())
```

| | |
|---|---|
| `audio.input(name?)` | The channel currently being rendered. `ctx.input` is this |
| `audio.left(name?)` / `audio.right(name?)` | A fixed side, whichever channel is rendering |
| `audio.sidechain()` | A second live input, by convention the detector's signal |
| `audio.lane()` | Which channel is rendering: 0 left, 1 right |

Sidechains, stereo, and anything cross-channel need more than one live
signal.

A port with nothing connected reads zero. An unconnected multiply goes
quiet. An unconnected ducker stops ducking. Neither throws.

### Wiring a second input

A Material that reads `audio.sidechain()` gets a second real input on its
renderer node. Declare where it comes from:

```ts
ducker.setAudioSource('sidechain', { kind: 'track', trackId: kick.id });
```

The renderer resolves that when it builds the graph. Naming a port the graph
does not read throws.

## Channels

A graph that reads live audio is evaluated **once per output channel**, each
channel with its own node state. Write a filter once and it is a stereo
filter.

Because a graph can ask which channel it is on, mid/side, width, swap,
balance, and true stereo pan are arrangements of two numbers:

```ts
// Mid/side width
const mid = audio.left().add(audio.right()).mul(0.5);
const side = audio.left().add(audio.right().mul(-1)).mul(0.5).mul(params.width);
return mid.add(side.mul(uniform(1).add(audio.lane().mul(-2))));

// Channel swap
return select(audio.right(), audio.left(), { which: audio.lane() });
```

A graph that reads no live audio is evaluated once and mirrored across
channels.

## The transport

Everything else in ASL is a pure function of its inputs and its own state.
A transport node is a function of the host's musical position.

```ts
graph: ({ input }) => delay(input, { timeSec: transport.seconds(0.75) })
```

That is a dotted eighth. It stays a dotted eighth through a tempo change,
which a delay time in seconds cannot do.

| | |
|---|---|
| `transport.beats()` | Position in quarter-note beats, fractional, advancing while rolling |
| `transport.bars()` | Position in bars from `beatsPerBar` and `beatUnit` |
| `transport.bpm()` | Tempo, as a value to compute with |
| `transport.beatsPerBar()` | Time-signature numerator |
| `transport.beatUnit()` | Time-signature denominator. 4 is a quarter, 8 is an eighth |
| `transport.playing()` | 1 while rolling, 0 when stopped |
| `transport.phase(length)` | A 0..1 ramp within each division: a grid-locked LFO |
| `transport.pulse(length)` | One sample at each boundary: a grid-locked clock |
| `transport.seconds(length)` | That many beats in seconds at the current tempo |
| `transport.division(index)` | A menu index looked up in a table of note lengths |

Lengths are in beats, where a beat is a quarter note. `SYNC_DIVISIONS` names
them: `1/8` is 0.5, `1/8.` is 0.75, `1/8T` is a third.

### Time signature is two numbers

`beats` and `bpm` stay quarter-note. The signature does not change what a
beat is. It is two fields on the anchor:

- `beatsPerBar`: the numerator (6 in 6/8)
- `beatUnit`: the denominator (8 in 6/8). Absent or non-positive means 4,
  so every snapshot written before this field existed is still 4/4

A bar is `beatsPerBar * (4 / beatUnit)` quarter notes. `barBeats` and
`normalizeBeatUnit` are that arithmetic. 4/4 and 3/4 are unchanged. 6/8 is
three quarters. 2/2 is four.

Do not fold the denominator into tempo. A host that publishes
`bpm * (timeSigD / 4)` makes `transport.seconds(1)` a signature beat
instead of a quarter, and every `SYNC_DIVISIONS` menu is then wrong.

`transport.bars()` uses `barBeats`. So does `Time.bars` when it resolves
against a scene. After changing either field, call `scene.publishTransport()`.

### Locked to the song, not to when playback started

**Starting playback at bar 5 gives the same phase as playing through to bar
5.** A free-running oscillator cannot do that. A synced tremolo picks up at
the current musical position rather than restarting.

A stopped transport holds its position rather than advancing.

### Reaching a division from a menu

A division parameter is an `enum`, so it automates and saves like any other
parameter, and `transport.division` turns its index into beats:

```ts
params: { division: param.enum(COMMON_DIVISION_NAMES, { default: '1/8' }) },
graph: ({ input, params }) =>
  delay(input, {
    timeSec: transport.seconds(
      transport.division(params.division, { divisions: COMMON_DIVISION_BEATS }),
    ),
  }),
```

The menu and the lookup table come from the same place. Two hand-typed lists
that drift apart give an effect a different note length than its label.

### One anchor, not a stream

A host publishes a musical position pinned to a moment on the audio clock,
and the audio thread derives every block's position from its own clock.

```ts
voice.setTransport({ atTime, beats, bpm, playing, beatsPerBar, beatUnit });
```

A host without a DAW session can publish the same fields from a Transport
material (`bpm`, `beatsPerBar`, `beatUnit`). Clock is free-running Hz.
Synced Clock, Synced Delay, and Looper read the snapshot and do not set
tempo.

Nothing is sent per block. Both sides read the same clock.

An `AudioScene` does this: play, pause, seek, and tempo all republish to
every live voice, and a voice created mid-song starts at the current
position rather than at beat zero.

When the scene has a tempo map, the anchor also carries every tempo change
still ahead, already converted to audio-clock time. The audio thread does no
musical arithmetic to follow one: it picks the last change that has arrived
and derives from that. A synced effect changes tempo on the sample the
change lands on.

A ramp crosses as its two numbers and is integrated on the audio thread.
Starting or seeking into the middle of one uses the slope of the span the
playhead is inside, not the tempo at the last marker.

## Measurement taps

Everything above moves data **into** the audio thread. A tap is how data
comes back out: a passthrough node that records what went by without
changing it.

```ts
graph: ({ input }) => tap.capture(tap.meter(input, { id: 'level' }), { id: 'scope' })
```

| | |
|---|---|
| `tap.meter(x, { id })` | Peak and level over the interval, two operations per sample |
| `tap.capture(x, { id, windowSize })` | The last N samples, one store per sample |

### Reading them

```ts
voice.setAnalysisInterval(30);        // Hz. Zero, the default, means never.
const off = voice.onAnalysis((frame) => {
  frame.meters.level;                 // { peak, rms } since the last frame
  frame.captures.scope;               // Float32Array, oldest sample first
});
```

**The default is off.** An unread tap costs its own two operations and
nothing else: no messages, no allocation, no work on the main thread.
Reporting at block rate would be several hundred messages a second per
voice.

**The audio thread captures; the main thread analyses.** A capture copies
samples into a ring buffer and stops there. Spectrum, pitch, and loudness
run on the main thread from the captured window. Running that analysis on
the audio thread at display rates is tens of millions of operations a
second.

Each frame covers exactly the interval since the last one. No decay, no
smoothing. Falloff belongs to whatever draws the meter.

### One rule

A tap records the **left channel, once**. Not both channels, and not both
evaluation passes of a graph containing a block-rate stage. Recording both
channels would make a meter mean something different depending on whether
the graph happened to be stereo. If you want the sum, tap it:

```ts
tap.meter(audio.left().add(audio.right()).mul(0.5))
```

## Two ways to chain

**Inside a Material**, operations fuse into one unit. Cheaper.

**Between Materials**, a track's insert chain creates real edges between
separate units. More expensive. Adds and removes effects while audio is
running, addresses each effect's parameters independently for automation,
and compensates latency per effect.

## What is missing

- **Author-time type checking of graphs.** Errors surface when a graph is
  built, which is early, but they are not caught by the type system.
- **Multi-output Materials.** A Material has one output, so splitting a
  stereo pair into two independently routed signals is a graph shape rather
  than a node. The merge direction works.
- **A spectrum as a graph node.** FFT bins stay on the main thread. Tuner
  and Analyzer publish the scalars they already compute (`note`, `hz`,
  `cents`, `gate`, `peak`, `rms`, `lufs`) as CV. Flatten turns those
  cables into `pitch` / `peak` / `rms` followers on the same audio.
