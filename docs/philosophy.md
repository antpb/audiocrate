# Philosophy

Audiocrate is inspired by how three.js is organized: a scene of objects,
materials you can write yourself, and something that turns that data into
output. It is not an editor. `editor/` in this repo is an example app and
is not in the npm package.

## Shape

three.js is a scene graph, a material system you can extend (`ShaderMaterial`
exists so the library does not have to know about a particular surface),
and renderers that draw a scene. Editors are built on it. They do not have
to agree with each other.

Audiocrate uses that split:

| three.js | crate |
|---|---|
| `Scene` | `AudioScene` |
| `Mesh` (geometry + material) | `Clip` (buffer + AudioMaterial) |
| `Material` / `ShaderMaterial` | `AudioMaterial` / an AudioMaterial with an ASL graph |
| `WebGLRenderer` | `WebAudioRenderer` (browser worklet), `OfflineRenderer` (Node), CrateASL (Swift), Android Hermes worklet |

The mapping stops where audio is not graphics.

`Object3D` is a transform hierarchy (parent, children, matrix). `Track` and
`Bus` are mixer nodes: volume, pan, mute, and an insert chain. Point sources
and the listener live on `scene.spatial`.

three.js loaders mostly live in addons. Audiocrate's loaders (`AudioLoader`,
`MidiLoader`, `ProjectLoader`) are in this package.

You do not pass an `AudioScene` to a renderer the way you pass a `Scene` to
`WebGLRenderer`. Live playback is a method on the scene. `OfflineRenderer`
takes an AudioMaterial graph. What is shared is the graph and the interpreter,
not a `render(scene)` signature.

## What is different about audio

**Timing.** A frame forty milliseconds late is one dropped frame. Forty
milliseconds late in audio is a different rhythm. Audiocrate has a DAW-like
transport with one scheduling origin, a shared clock in the collaboration
layer, and analysis that distinguishes delayed readings from live ones.

**The audio thread is not the main thread.** Rendering happens in an isolated
context with no network, no imports, and a deadline measured in microseconds.
A block that overruns is a click. Kernels and measurement exist in the form
they do because of this.

## Rules

### Core ships primitives, not products

Audiocrate ships the maths to build a reverb. It does not ship a branded reverb.
A component belongs in core if:

1. **It is a primitive.** Several different-sounding things can be built from
   it, rather than it already sounding like one thing.
2. **It is general.** Not specific to one kind of application.
3. **Correctness is agreed.** Two implementations can be compared.
4. **It is brand-free.** It sounds like a category, not a product.
5. **It is cheap unused.** Having it available costs nothing when it is not
   in a graph.

A filter passes. A guitar amplifier does not. Both belong in the ecosystem.
Only one belongs in core.

### The extension point is a plugin, not a branch

If crate needs to know something specific about a kind of AudioMaterial,
that is a missing field on the plugin contract, not a conditional inside
crate. The
library contains no name of any particular instrument or effect.

### A graph is data, not a running process

An ASL graph is a plain object. It can be serialised, sent to another thread,
diffed, stored in a project file, and rendered offline. Nothing in it holds
an audio context or a buffer. That is how the same AudioMaterial works in real
time and offline without a second implementation.

### Dependencies are injected

The audio context, the renderer, the file reader, and the network transport
are all injected. The library is testable without a browser. A host can
substitute its own. There is no cloud inside the library.

### Failures degrade

- An asset that will not load leaves an AudioMaterial at its defaults. The chain
  still runs.
- An unbound effect passes audio through. An unbound instrument is silent.
- A malformed packet on a peer-to-peer link is dropped.

Every guide has a section on what is missing.

## Where it runs

| Place | Role |
|---|---|
| Browser worklet | Live voice |
| `OfflineRenderer` | Bounce and tests. Shares `compile.ts`. |
| CrateASL (Swift) | Independent interpreter. The conformance twin. |
| crate-xr | Host adapter into `THREE.Audio`. |
| Android (Hermes + Oboe) | Same TypeScript interpreter, C++ kernels. `example-android/`. |

## Scope

**No generative models.** Audiocrate does not ship a model that writes music.

**No mandatory cloud.** Hosted convenience, if any, has a local path beside
it. Collaboration signalling is opt-in. The data path is peer to peer.

**Not an application.** Audiocrate is not a DAW and will not grow into one.

**Not a competitor to plugin standards.** Audiocrate hosts DSP. It does not
replace AU, VST, or similar formats.
