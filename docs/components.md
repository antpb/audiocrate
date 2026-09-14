# The component library

Two libraries.

**Nodes** are the operations you write inside a graph. They compose into an
expression and fuse into a single unit of work. See [the ASL guide](asl.md).

**AudioMaterials** are complete, named, parameterised units built out of those
nodes. They drop onto a track.

```ts
import { lowpassMaterial, filter } from 'audiocrate';

track.materials.add(lowpassMaterial);               // the AudioMaterial
graph: ({ input }) => filter.lowpass(input, { cutoff: 800 });   // the node
```

Almost every AudioMaterial in this document is a few lines of ASL. User-defined
AudioMaterials sit alongside them.

The editor palette (every `kind`, jack, range, default, and file slot) is in
[the materials catalog](../editor/docs/materials.md). That file is generated
from the catalog. This page is the library overview and the ASL node list.

## AudioMaterials

Every AudioMaterial below is exported by name. An AudioMaterial carries a
`kind`, a parameter schema, and a graph. Pure-ASL AudioMaterials need no
registration: adding one to a track is enough. Only AudioMaterials with
files, presets, reported latency, or bound DSP need to be registered, and
only one core AudioMaterial has any of those.

Parameters listed empty means the AudioMaterial has no controls. Each parameter
also declares what kind of control it wants, which a host reads through
`describeAudioMaterial`; the tables below mark the ones that are not plain
faders.

### Sources

Note-driven or free-running. These read no input.

| AudioMaterial | Parameters | |
|---|---|---|
| `oscillatorMaterial` | `type`, `width`, `octave`, `detune`, `gain`, ADSR | Polyphonic note-driven oscillator. The envelope is live, like SynthVoice's and Wavetable's |
| `toneMaterial` | `freq`, `gain` | Free-running sine. Sounds on Play without a gate |
| `noiseMaterial` | `color`, `gain`, `cutoff` | Six spectral colors through a lowpass |
| `impulseMaterial` | | A single-sample impulse from a gate |
| `wavetableMaterial` | `position`, octave, detune, gain, ADSR | Scans a bank of single-cycle frames. `createWavetableMaterial`, `setWavetableAsset` |
| `samplePlayerMaterial` | `rate`, `start`, `loop`, `pitch`, `gain` | One-shot or loop from a loaded file. Pitch is semitones. `createSamplePlayerMaterial`, `setSampleAsset` |
| `synthVoiceMaterial` | wave, unison, filter, env amt, ADSR | A complete subtractive voice |

### Filters

| AudioMaterial | Parameters | |
|---|---|---|
| `lowpassMaterial` | `cutoff`, `q` | |
| `highpassMaterial` | `cutoff`, `q` | |
| `bandpassMaterial` | `cutoff`, `q` | |
| `notchMaterial` | `cutoff`, `q` | |
| `allpassMaterial` | `cutoff`, `q` | Phase without amplitude |
| `lowShelfMaterial` | `freq`, `gainDb`, `q` | |
| `highShelfMaterial` | `freq`, `gainDb`, `q` | |
| `parametricEqMaterial` | HP/LP plus low, two mids, high | Channel EQ. Low/high are shelf or peak. Dry at 0 dB with filters off. |
| `onePoleLowpassMaterial` | `cutoff` | Cheap, stable when modulated |
| `onePoleHighpassMaterial` | `cutoff` | |
| `svfLowpassMaterial` | `cutoff`, `q` | A topology that stays stable under fast modulation |
| `svfHighpassMaterial` | `cutoff`, `q` | |
| `svfBandpassMaterial` | `cutoff`, `q` | |
| `ladderMaterial` | `cutoff`, `resonance`, `drive` | Resonant ladder. `drive` saturates into the filter, and 1 is exactly clean |
| `combMaterial` | `freq`, `feedback`, `mix` | Tuned comb |
| `slopeLowpass12Material` | `cutoff` | Fixed slope, no resonance control |
| `slopeLowpass24Material` | `cutoff` | |
| `slopeHighpass12Material` | `cutoff` | |
| `dcBlockerMaterial` | | Removes offset |

Several responses appear more than once in different topologies. A swept
lowpass and a static lowpass use different implementations.

### Nonlinear

| AudioMaterial | Parameters | |
|---|---|---|
| `softClipMaterial` | `drive` | Smooth saturation |
| `hardClipMaterial` | `drive` | Abrupt ceiling |
| `bitcrushMaterial` | `bits` (stepper) | Amplitude resolution reduction |
| `downsampleMaterial` | `factor` (stepper) | Time resolution reduction |
| `fullRectifyMaterial` | | |
| `halfRectifyMaterial` | | |
| `waveshapeMaterial` | `curve`, `drive`, `mix` | Transfer curve. Mix at 0 is dry |
| `ringModMaterial` | `freq`, `mix` | |
| `syncedTremoloMaterial` | `division` (menu), `depth` | Amplitude modulation locked to the beat |

### Dynamics

| AudioMaterial | Parameters | |
|---|---|---|
| `compressorMaterial` | `threshold`, `ratio`, `attack`, `release`, `makeup`, `mix` | Mix at 0 is dry |
| `limiterMaterial` | `threshold`, `attack`, `release` | |
| `gateMaterial` | `threshold`, `attack`, `release`, `hold` | `hold` is the shortest time it may stay open, so decaying material does not chatter it |
| `expanderMaterial` | `threshold`, `ratio`, `attack`, `release` | |
| `transientMaterial` | `attack`, `sustain` | Shapes attack and sustain independently of level |
| `envelopeFollowerMaterial` | `attack`, `release` | Output is a control signal, not audio |

### Time

| AudioMaterial | Parameters | |
|---|---|---|
| `delayMaterial` | `timeSec`, `feedback`, `mix` | Mix at 0 is dry |
| `reverbMaterial` | `size`, `decay`, `damp`, `mix` | Comb tank. Mix at 0 is dry |
| `reverseMaterial` | `timeSec` | Plays fixed-length windows backwards |
| `looperMaterial` | `record`, `play`, `overdub`, `undo`, `length` (bars, 0 = free), `threshold`, `quantize` (Free/Beat/Bar), `clear`, `mix` | Record captures. Play starts, restarts, or closes a take. Bars 0 is free up to the ring. N bars auto-closes on that many measures. Threshold 0 is off. Quantize snaps a free take. Outlets: `audio`, `start` (first play sample and each wrap), `end` (last sample of the loop). Mix at 0 is dry |
| `pitchShiftMaterial` | `pitch` (st), `mix` | Mix at 0 is dry |
| `grainMaterial` | `duration`, `position`, `rate` | Granular playback of a supplied buffer. `createGrainMaterial`, `setGrainAsset` |
| `syncedDelayMaterial` | `division` (menu), `feedback`, `mix` | Delay time is a note length, so it survives a tempo change |
| `irMaterial` | `mix`, `gain` | Convolution. `createIrMaterial`, `setIrAsset`, `irLatencySamples` |

`irMaterial` is the one core AudioMaterial with a plugin (`irPlugin`),
because it loads a file and reports latency. `registerCoreMaterials()`
registers it.

### Control

None of these produce audio. They produce numbers that drive things that do.

| AudioMaterial | Parameters | |
|---|---|---|
| `controlMaterial` | `value` | A constant, so an automation lane has something to write to |
| `offsetMaterial` | `amount` | Adds a constant |
| `slewMaterial` | `rise`, `fall` | Rate limiter, with asymmetric rise and fall |
| `sampleHoldMaterial` | `freq`, `clock` (jack) | `freq` at 0 means somebody else's clock |
| `transportMaterial` | `bpm`, `beatsPerBar`, `beatUnit` (steppers) | Host tempo and time signature. Params publish the session clock. The graph outlet is a quarter-note pulse. The editor also exposes `bpm`, `beats`, `bars`, `playing`, `beatsPerBar`, `beatUnit`, and `pulse` jacks |
| `clockMaterial` | `freq`, `reset` (jack) | Free-running pulse train |
| `clockDivideMaterial` | `factor` (stepper), `reset` (jack) | |
| `clockMultiplyMaterial` | `factor` (stepper), `reset` (jack) | |
| `triggerMaterial` | `threshold` | An edge when the input crosses |
| `pulseMaterial` | `widthSec` | Fixed-width pulse from an edge |
| `flipFlopMaterial` | | Toggles on each edge |
| `compareGreaterMaterial` | `threshold` | |
| `compareLessMaterial` | `threshold` | |
| `logicAndMaterial` | `other` | |
| `logicOrMaterial` | `other` | |
| `logicXorMaterial` | `other` | |
| `logicNotMaterial` | | |
| `quantizeMaterial` | `root`, `scale` (menus) | Snaps a pitch signal to a scale. Note names and scale names, not indices |
| `euclideanMaterial` | `steps`, `hits`, `rotation` (steppers), `clock` and `reset` (jacks) | Evenly spread hits across a step count |
| `sequencerMaterial` | `step0` to `step7`, `clock` and `reset` (jacks) | Advances through eight values on a clock |
| `randomSteppedMaterial` | `freq` | New value per tick |
| `randomSmoothMaterial` | `freq` | Interpolated between values |
| `adsrMaterial` | `attack`, `decay`, `sustain`, `release`, `amount` | Note-driven. Times are live |
| `dahdsrMaterial` | `delay`, `attack`, `hold`, `decay`, `sustain`, `release` | |
| `syncedRampMaterial` | `division` (menu), `depth` | A 0..1 ramp locked to the grid |
| `syncedClockMaterial` | `division` (menu) | A pulse on each division boundary, for the sequencer nodes. Reads the host snapshot. Does not set bpm |
| `lfoMaterial` | `type`, `width`, `rate`, `amount`, `phase`, `reset` (jack) | Same eight waves as the oscillator, at control rate. `phase` offsets where the shape is read without moving where the cycle has got to |
| `breakpointEnvelopeMaterial` | `time0`..`time3`, `level0`..`level3` | Four live points from a gate |

This is the largest category.

**Jacks a cable cannot drive.** Nine inlets the palette draws accept a cable,
save it in the document, and have no effect on the sound. They are two
different things wearing one face.

`gate` on the four polyphonic voices (SynthVoice, Oscillator, Wavetable, ADSR)
belongs to the voice allocator rather than to the graph: it is a flag on the
render state, not a value a node can read. It stays on the canvas because a
*keyboard* cable into it is not a signal, it is the statement that this module
is what the keys play, and flatten reads it exactly that way while contributing
no node. To gate a voice from inside a patch, drive its `gain` or `velocity`;
both are live.

The five position parameters on the two spatial modules (`spatialsource.x/y/z`,
`spatialmaster.yaw/pitch`) are real controls whose effect lives outside the
graph: an automation lane writes them, they are saved with the patch, and the
host's spatial renderer acts on them. What cannot reach them is a cable. That
is a gap in those two modules rather than in the palette, and removing the
jacks would hide a control that works to conceal one route into it that does
not.

To gate an envelope from inside a patch, use `dahdsrMaterial`, whose trigger is
`input`, a real audio inlet. `breakpointEnvelopeMaterial` and
`samplePlayerMaterial` take theirs the same way. The list is pinned by
`DeadJackTests` in the Swift package, which measures it rather than trusting
it: a new dead jack fails, and so does fixing one.

**Reset.** The five modules that carry a position in a pattern (Clock, Clock
Divide, Clock Multiply, Euclidean, Sequencer) take a `reset` jack. A rising
edge puts the module back to its first step; it is edge-triggered, so a signal
held high resets once rather than pinning the pattern at step zero.

Patch the Transport's `playing` outlet into it and the pattern starts with the
song. That cable is the point of the jack: a free-running clock's phase has
nothing to do with the song, and a step counter under even a Synced Clock is
wherever it was left, so without a reset a pattern comes back rotated by
however far it had got when somebody last pressed Stop. Synced Clock and
Synced Ramp need no reset, being read off the song position with no state of
their own, but anything counting steps downstream of one does.

`transportMaterial` publishes the session clock. Clock is free-running Hz.
Synced Clock reads the host snapshot and does not set bpm. Synced Delay and
Looper need some host to publish tempo. Flatten treats Transport as host
I/O: cables from its named outlets become `transport.*` reads, and the knobs
are not exported as plugin params.

MIDI In (`midiin`) and MIDI Out (`midiout`) are the same kind of host I/O
as Line and Master. Device ids are strings the host stores. They name a
port on this machine and must not be sent over a multiplayer session:
`stripHostLocalPatch` / `restoreHostLocalPatch`. MIDI channel, message, and
width are patch settings and do sync. Flatten skips the nodes. MIDI In is
last-note analog, like Keyboard, and a note/gate cable into an instrument
allocates voices. MIDI Out is a sink: gate holds the voice, trig is the
event (a pulse plus a note). If gate is also patched, trig retriggers only
while gate is high. If gate is not patched, the note lasts until trig falls
or `widthSec`, whichever is later.

### Routing

| AudioMaterial | Parameters | |
|---|---|---|
| `gainMaterial` | `gain` | |
| `invertMaterial` | | Flips sign |
| `bypassMaterial` | | Passes through unchanged. Useful as a placeholder in a chain |
| `mixMaterial` | `a`, `b`, `c` | Weighted sum of three inputs |
| `selectMaterial` | `other`, `which` (switch) | Chooses between two signals |
| `panLeftMaterial` | `pan` | |
| `panRightMaterial` | `pan` | |

### Stereo

Each of these is one expression over the two channel values.

| AudioMaterial | Parameters | |
|---|---|---|
| `monoSumMaterial` | | Fold to mono, at the level a correlated pair started at |
| `monoLeftMaterial` | | Left to both sides |
| `monoRightMaterial` | | Right to both sides |
| `channelSwapMaterial` | | |
| `stereoWidthMaterial` | `width` | 0 collapses, 1 is unity, above widens. The centre never moves |
| `midSideEncodeMaterial` | | |
| `midSideDecodeMaterial` | | |
| `balanceMaterial` | `left`, `right` | Independent level per side |
| `stereoPanMaterial` | `pan` | True stereo pan, not two mono gains |
| `autoPanMaterial` | `rate`, `depth` | |
| `haasMaterial` | `delayMs` | Width from a short one-sided delay |
| `stereoMergeMaterial` | | Two live inputs into one stereo pair. `createStereoMergeMaterial` |

### Sidechain

These read a second live input. Declare where it comes from with
`material.setAudioSource('sidechain', ...)`; see [the ASL guide](asl.md).

| AudioMaterial | Parameters | |
|---|---|---|
| `sidechainCompressorMaterial` | `threshold`, `ratio`, `attack`, `release` | Compresses one signal by another's level |
| `duckerMaterial` | `amount`, `attack`, `release` | One control |
| `sidechainGateMaterial` | `threshold`, `attack`, `release`, `hold` | Opens when the detector does |
| `audioMultiplyMaterial` | `mix` | Ring modulation by a live signal |
| `audioMixMaterial` | `level` | Sums a second input |
| `crossfadeMaterial` | `position` | |
| `inputSelectMaterial` | `which` (switch) | Hard switch between two live inputs |

Each has a factory (`createDuckerMaterial` and so on) because a sidechain
AudioMaterial holds a routing declaration, and two duckers on two tracks
need two instances rather than one shared object.

### Measurement

These pass audio through unchanged and report what went by.

| AudioMaterial | Parameters | |
|---|---|---|
| `meterMaterial` | | Peak and level, also as CV (`peak`, `rms`). `createMeterMaterial`, `METER_TAP` |
| `scopeMaterial` | | A window of samples, plus `peak` / `rms` CV. `createScopeMaterial`, `SCOPE_TAP` |
| `analyzerMaterial` | | Meter plus spectrum. CV: `note`, `cv` (1V/oct), `hz`, `cents`, `gate`, `peak`, `rms`, `lufs`. `createAnalyzerMaterial` |
| `tunerMaterial` | | Same capture, pitch-first. CV: `note`, `cv`, `hz`, `cents`, `gate`. `createTunerMaterial` |
| `rmsMaterial` | `windowSec` | Level as a control signal inside the graph |
| `peakMaterial` | `release` | |
| `onsetMaterial` | `threshold` | Fires on transients |

The first four send data out to the main thread and cost nothing until
something reads them. The last three stay inside the graph and drive other
nodes.

## Nodes

What you write inside `graph`. Numbers are accepted anywhere a value is.

Every value is chainable:

| | |
|---|---|
| `.mul(x)` `.add(x)` | Arithmetic |
| `.range(min, max)` | Map from -1..1 into a range |
| `.toFrequency()` | Note number to hertz |
| `.trigger(velocity)` | Gate an envelope |

### Sources

```ts
osc({ freq, type?, width? })        // sine, saw, square, triangle
lfo({ rate, shape?, width?, phase?, reset? })
noise({ color? })                  // white, pink, brown
impulse({ gate? })
wavetable({ freq, table?, position?, frameSize? })
samplePlay({ rate?, gate?, position?, loop?, pitch?, table? })
uniform(x)                         // a constant or an external value
```

### Filters

```ts
filter.lowpass(x, { cutoff, q? })
filter.highpass(x, { cutoff, q? })
filter.bandpass(x, { cutoff, q? })
filter.notch(x, { cutoff, q? })
filter.allpass(x, { cutoff, q? })
filter.peaking(x, { freq, gainDb, q? })
filter.lowshelf(x, { freq, gainDb, q? })
filter.highshelf(x, { freq, gainDb, q? })
filter.onePoleLowpass(x, { cutoff })
filter.onePoleHighpass(x, { cutoff })
filter.svf(x, { cutoff, q?, mode? })
filter.ladder(x, { cutoff, resonance?, drive? })
filter.comb(x, { freq, feedback?, mix? })
filter.slope(x, { cutoff, poles?, mode? })
dcBlock(x)
```

### Envelopes

```ts
env.adsr({ a, d, s, r })
env.dahdsr({ delay?, attack?, hold?, decay?, sustain?, release?, gate? })
env.breakpoints({ times, levels, gate? })
```

### Nonlinear

```ts
clip(x, { drive?, mode? })         // soft or hard
bitcrush(x, { bits? })
downsample(x, { factor? })
rectify(x, { mode? })
waveshape(x, { curve? })
```

### Time

```ts
delay(x, { timeSec, feedback?, mix?, maxTimeSec? })
reverse(x, { timeSec?, maxTimeSec? })
looper(x, { record?, play?, overdub?, undo?, duration?, bars?, clear?, threshold?, quantize?, fadeSec?, latencySec?, maxTimeSec?, box?, field? })
createLooperBox()
// field: 'audio' (default), 'start', or 'end'. Share `box` so those reads tick once.
pitchShift(x, { pitch?, unit? })
grain(triggerIn, { duration?, position?, rate?, table? })
```

### Dynamics

```ts
compressor(x, { threshold?, ratio?, attack?, release?, sidechain? })
expander(x, { threshold?, ratio?, attack?, release? })
transient(x, { attack?, sustain? })
envFollow(x, { attack?, release? })
```

### Control

```ts
clock({ freq?, reset? })
clockDivide(x, { factor?, reset? })
clockMultiply(x, { factor?, reset? })
trigger(x, { threshold? })
pulse(x, { widthSec? })
flipFlop(x)
compare(x, { threshold?, mode? })
logic.and(a, b)   logic.or(a, b)   logic.xor(a, b)   logic.not(a)
quantize(x, { root?, scale? })
euclidean(clockIn, { steps?, hits?, rotation?, reset? })
sequencer(clockIn, [ ... ], { reset? })
random({ freq?, mode? })
slew(x, { rise?, fall? })
sampleHold(x, { freq?, clock? })
```

`quantizeToScale`, `euclideanPattern`, and `QUANTIZE_SCALES` are exported
too, so an interface can show what a graph is about to do before it does it.

### Analysis

```ts
rms(x, { windowSec? })
peak(x, { release? })
onset(x, { threshold? })
pitch(x, { field? })   // hz | midi | cents | gate. Hop-held zero-crossing follow.

```

### Routing and stereo

```ts
mix(a, b, c, ...)
select(a, b, { which })
panLaw(x, { pan, channel })
audio.input(name?)        audio.left(name?)   audio.right(name?)
audio.sidechain()         audio.lane()
```

### The transport

```ts
transport.beats()           transport.bars()
transport.bpm()             transport.playing()
transport.beatsPerBar()     transport.beatUnit()
transport.phase(lengthBeats)
transport.pulse(lengthBeats)
transport.seconds(lengthBeats)
transport.division(index, { divisions })
```

`beats` and `bpm` are quarter-note. `bars` uses `beatsPerBar` and
`beatUnit`. `barBeats` / `normalizeBeatUnit` are that conversion.
`SYNC_DIVISIONS` names note lengths in quarter-note beats;
`COMMON_DIVISION_NAMES` and `COMMON_DIVISION_BEATS` are the menu and lookup
table a synced AudioMaterial pairs. See [the ASL guide](asl.md).

### Measurement and kernels

```ts
tap.meter(x, { id })
tap.capture(x, { id, windowSize? })
kernel.seam(slot, x)
kernel.source(slot, x, { fallback })
```

See [the ASL guide](asl.md) for taps and [the kernels guide](kernels.md) for
slots.

## What is missing

- **A tempo-synced reverb, chorus or phaser.** The transport nodes exist and
  the four synced AudioMaterials are examples rather than a complete set. There
  is a free-running `reverbMaterial` and a Space Reverb kernel.
- **A published inspector.** Every AudioMaterial here describes its own
  controls through `describeAudioMaterial`. Audiocrate does not yet ship the
  component that draws them.
- **Parameter kinds are declared but not everywhere they could be.** The
  core library uses menus, switches, and steppers where those match the
  control. A plugin package's forty-parameter tree is still mostly ranges.
- **Multi-output.** An AudioMaterial has one output, so a splitter is a graph
  shape rather than a node. `stereoMergeMaterial` shows the merge direction
  works.
