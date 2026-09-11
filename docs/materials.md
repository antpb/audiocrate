# AudioMaterials

An AudioMaterial is the unit of DSP: **a parameter schema and a signal
graph, both plain data.**

```ts
import { AudioMaterial, param, filter, osc, env } from 'audiocrate';

const lowpass = new AudioMaterial({
  name: 'Lowpass',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz' }),
    resonance: param.range(0.1, 20, { default: 0.707 }),
  },
  automatable: ['cutoff', 'resonance'],
  graph: ({ input, params }) => filter.lowpass(input, {
    cutoff: params.cutoff,
    q: params.resonance,
  }),
});
```

Add it to a track's `materials` chain and it processes audio. Render it
offline and it produces the same samples. Read its `params` and you have the
data for a control panel.

## Effects and instruments

An effect reads `input`. An instrument reads `note` and `velocity` and ignores
`input`. That is the whole difference, and it is a property of the graph
rather than of a class hierarchy.

```ts
const synth = new AudioMaterial({
  name: 'Simple Synth',
  params: { cutoff: param.range(100, 12000, { default: 2000, unit: 'Hz' }) },
  polyphony: 8,
  graph: ({ note, velocity, params }) =>
    filter.lowpass(
      osc({ freq: note.toFrequency(), type: 'saw' })
        .mul(env.adsr({ a: 0.01, d: 0.2, s: 0.7, r: 0.4 }).trigger(velocity)),
      { cutoff: params.cutoff },
    ),
});
```

A track holds effects in `materials` and an instrument in `instrument`. They
are placed differently because they sit in different places in the signal
flow, not because they are different kinds of object.

## Parameters

A parameter declares data, not a value:

```ts
param.range(-18, 18, { default: 0, unit: 'dB' })
param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' })
param.stepped(1, 16, { step: 1, default: 8 })
param.enum(['sine', 'saw', 'square'], { default: 'saw' })
param.toggle({ default: false, labels: ['Play', 'Record'] })
```

Validated at declaration: minimum below maximum, default inside the range, a
step that divides the span, a default that is one of the options.

Because parameters are declared data rather than fields on a class:

- The data a control panel is built from. See [the inspector model](#the-inspector-model).
- Automation writes only keys listed in `automatable`.
- A host can map them onto an external parameter tree.
- Every declared parameter exists in the graph whether the graph reads it or
  not, so a parameter that only some presets use is still addressable.

### Every parameter is one number

An enumeration is an index. A toggle is 0 or 1. A stepped control is a range
on a grid. There is no second value type.

A parameter crosses to the audio thread, gets written by an automation lane,
gets quantized onto a collaboration wire, and maps onto a plugin parameter
tree. Those all speak numbers. A parameter kind adds meaning, validation, and
presentation on top of a number. It never changes what the number is.

Every descriptor carries `min`, `max`, and `default` whatever its kind. Code
that only wants a fader can read those three and ignore the rest.

### Taper

A 20 Hz to 20 kHz fader declared linear puts the bottom two octaves in the
first one percent of its travel.

```ts
curve: 'log'   // geometric. Every octave the same distance. Needs a positive minimum
curve: 'exp'   // squared. More travel at the low end, and works from zero
```

The taper affects `normalizeParam` and `denormalizeParam` only. The stored
value, what automation writes, and what the graph reads are always real units
on a linear scale.

A host drawing its own fader should travel in 0..1 and convert, rather than
interpolating between `min` and `max`, or a tapered control will not agree
with its own readout.

### Reading and writing

```ts
material.getParam('cutoff');
material.setParam('cutoff', 4000);

material.setOption('shape', 'square');   // enum params, by name
material.getOption('shape');
material.formatParam('cutoff');          // '4000 Hz'
```

**Out of range throws. Off the grid snaps.** A value outside the declared
bounds is a caller bug. A value between two steps is what an automation lane
and a fader drag both produce, so the descriptor quantizes rather than
asking every caller to.

### The inspector model

Audiocrate is not a UI library. It ships the model a control panel is built from,
not the panel.

```ts
import { describeAudioMaterial } from 'audiocrate';

for (const control of describeAudioMaterial(material).controls) {
  control.kind;        // 'fader' | 'stepper' | 'menu' | 'switch'
  control.label;       // declared, or derived from the param name
  control.value;       // current
  control.normalized;  // the same, as 0..1
  control.display;     // '4000 Hz', 'square', 'Record'
  control.options;     // menu labels, for a menu or a switch
  control.automatable;
}
```

The model is plain data. It does not hold the AudioMaterial and it does not
update: take a fresh one when values change.

A React inspector, a canvas inspector, and a plugin parameter tree can
share that description.

## The graph builder

The graph is a function from a context to a value:

```ts
graph: ({ input, note, velocity, params, audio }) => /* an ASL value */
```

Names you destructure are the inputs. There is no separate declaration step:
destructuring **is** the declaration. `params` and `audio` are reserved;
everything else resolves to a named input.

- `input` is the incoming audio for an insert.
- `note` and `velocity` are the current note for an instrument.
- `params` holds one node per declared parameter.
- `audio` reaches live inputs beyond the main one, and the channel being
  rendered. See [the ASL guide](asl.md).

Full detail on what you can build is in [the ASL guide](asl.md). Everything
crate ships is listed in [the component library](components.md). Editor
palette kinds, jacks, and param ranges are in
[the materials catalog](../editor/docs/materials.md).

## Polyphony

```ts
new AudioMaterial({ name: 'Pad', polyphony: 8, voiceStealing: 'oldest', graph })
```

`material.noteOn(60, { velocity: 0.8 })` and `material.noteOff(60)` allocate
across voices. When all voices are busy, the stealing policy decides which
one gives way.

## Channels

By default, an AudioMaterial that reads live audio is evaluated **once per
output channel**, with independent state per channel. One `filter.lowpass`
in a graph is a stereo filter, not two mono filters.

An AudioMaterial that reads no audio (a source) is evaluated once and mirrored.

Override it:

```ts
new AudioMaterial({ name: 'Meter', channels: 1, graph })  // control, mono
```

Setting `channels: 1` on a control-voltage output skips a second evaluation
that could not have produced a different answer.

## Plugins: publishing an AudioMaterial

An AudioMaterial on its own covers the common case. An AudioMaterial that
has files, a saved preset format, reported latency, or DSP that is not a
per-sample expression needs a **plugin**: a small object describing those
things.

```ts
import { registerAudioMaterial } from 'audiocrate';

registerAudioMaterial({
  kind: 'acme.tape',
  role: 'insert',
  label: 'Acme Tape',
  create: () => createTapeMaterial(),

  // Optional. Each field exists so crate does not need a conditional
  // in that spot.
  decodePreset: (blob) => JSON.parse(atob(blob)),
  emptyPreset: () => ({ drive: 0.5 }),
  applyPreset: (material, preset) => material.setParam('drive', preset.drive),
  assetRequests: (preset) => [
    { key: 'acme.curve', library: 'Curves', filename: preset.curve, decode: 'audio' },
  ],
  latencySamples: () => 64,
  bindLiveVoice: async (voice, material) => { /* load DSP, see kernels guide */ },
  bake: async (material, channels, sampleRate) => { /* offline render */ },
});
```

Every field past `kind`, `role`, and `create` is optional. A plugin
implementing none of them is a valid plugin: a plain AudioMaterial with a name.

Audiocrate contains no branch on any AudioMaterial's identity. If crate needs to
know something particular about a kind of AudioMaterial, that is a missing field
on this contract.

### Assets

A plugin declares the files it needs and Audiocrate fetches and decodes them:

```ts
assetRequests: (preset) => [{
  key: 'acme.curve',
  library: 'Curves',
  fallbackLibraries: ['LegacyCurves'],
  filename: preset.curve,
  decode: 'audio',
  optional: true,
}]
```

Audiocrate decodes two shapes, text and audio. Decoded assets land in an open
string-keyed map on the AudioMaterial. The plugin that wrote a key is the one
that reads it.

`fallbackLibraries` exists because archives drift: the same file ships under
different folder names across versions of an application, and a loader that
only knows the current name breaks old projects.

## Distribution

**An AudioMaterial whose DSP is expressible in ASL can be published as an
ordinary package.** A graph is data, so it crosses into the audio thread
with no build step. Install, register, use.

An AudioMaterial that needs DSP which is not a per-sample expression has a
second option, described in [the kernels guide](kernels.md): ship it as a
portable
module plus a descriptor, which any crate renderer can load from bytes
without having been built with it.

The one case that still needs a custom build is DSP that must be arbitrary
JavaScript on the audio thread.

## What is missing

- **A published inspector component.** The model is shipped. The component
  that renders it is not, so every host writes its own.
- **Grouped parameters.** A forty-parameter AudioMaterial describes forty
  controls in a flat list. Sections, pages, and dependent controls ("this
  only applies when that is on") are a host's problem today.
- **Preset management.** Plugins decode and apply presets. Audiocrate has no
  storage, browsing, or organisation for them.
