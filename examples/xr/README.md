# crate-xr

**Crate as a source for three.js audio, and an XR Publisher plugin built on it.**

three.js `Audio` is an `Object3D` that owns a `GainNode`. `PositionalAudio`
puts a `PannerNode` in front of it. Neither has an opinion about where the
sound comes from. Every three.js audio example starts by loading a file.

The seam is already there:

```js
sound.setNodeSource(audioNode);   // the same seam as setMediaElementSource
```

A crate voice is an `AudioNode`: one `AudioWorkletNode` running a fused ASL
graph.

```
three.js:  AudioLoader -> AudioBuffer -> Audio.setBuffer     -> panner -> listener
crate:     AudioMaterial    -> ASL graph   -> Audio.setNodeSource -> panner -> listener
```

A buffer is fixed samples. A graph is live: parameters move, the world can
drive them, and many objects can share one description while sounding
different.

XR Publisher's `resonance-plaza` plugin, when it has no stems, synthesises
loops sample by sample into `ctx.createBuffer`. This package uses a crate
AudioMaterial instead.

---

## Two things in this package

| | |
|---|---|
| `src/CrateAudio.ts` | The bridge. Reusable in any three.js project, not just XR Publisher |
| `src/plugin.ts` | `crate-stones`: a hillside of stones, built on the bridge |

```bash
npm run build     # -> dist/crate-stones-xr-publisher-plugin.umd.js
npm run demo      # builds the plugin, then a local XR Publisher world
npx vitest run    # the bridge and the DSP
node scripts/check-plugin.mjs      # the shipped bundle, in a browser
node scripts/render-preview.mjs out.wav   # offline render, no browser
```

From the audiocrate package root, `npm run example:xr` is the same as
`npm run demo` here. Open http://localhost:5176. See [`demo/`](demo/).

## Using the bridge

```js
const listener = XRPublisher.getAudioListener();   // never make a second one

const sound = await createCrateAudio(listener, myMaterial, {
  params: { pitch: 220, wind: 0.4 },
  volume: 0,
});

stone.add(sound.audio);        // it is a THREE.PositionalAudio
sound.rampVolume(1, 0.6);
sound.set('wind', 0.9);        // live, on the audio thread
sound.noteOn({ velocity: 0.8 });
sound.dispose();               // required, see below
```

`three` is not bundled and must not be: the engine's copy is already on the
page as `window.THREE`, and a second one breaks `instanceof` and doubles the
payload. `CrateAudio` describes the two classes it needs structurally, so
this package has no three dependency.

### What is different from `THREE.Audio`

`setNodeSource` sets `hasPlaybackControl = false`, so `play()`, `pause()` and
`stop()` throw. A crate voice is always running, like an `OscillatorNode`
source. What starts and stops is the sound the graph makes (`noteOn`,
parameters). `dispose()` is how it goes away.

## Deploying the plugin to a XR Publisher API worker

```bash
cp dist/crate-stones-xr-publisher-plugin.umd.js /path/to/api/plugins/
cd /path/to/api && npm run upload-build dist/xr-publisher.umd.js
```

Flat, no subfolder, and the `-xr-publisher-plugin.umd.js` suffix is
required: the uploader finds plugins with a non-recursive `readdirSync`
filtered on exactly that string.

---

## Three techniques in this plugin

### 1. Voices are pooled by distance

An `AudioWorkletNode` runs its process callback for as long as it is
connected. One voice per spawn puts a fused ASL graph on the audio thread
for every object in every loaded chunk.

The dominant cost here was one worklet per AudioMaterial that was out of
hearing range, not the interpreter. At most twelve stones are live at
once, always the nearest, re-decided on a 250 ms interval rather than per
frame. Walking out of range returns a voice to the pool. The browser check
asserts it.

### 2. The glow is measured inside the graph

`XRPublisher.getAudioAnalyser()` taps the whole spatial mix, so driving a
per-object visual from it makes every stone pulse to the sum of all of
them.

A `tap.meter` node inside the AudioMaterial measures that one voice, pre-panner,
on the audio thread, and costs nothing until a host asks for it:

```js
sound.onAnalysis((frame) => { level = frame.meters.stone.peak; }, 15);
```

### 3. Nothing calls `Math.random()`

XR Publisher requires a world to be identical for every visitor: placement
and generated content come from seeded PRNGs, and `Math.random()` is banned
for anything that should persist. Audiocrate's `noise` and `random` nodes call
`Math.random()` per sample, so a graph containing one is not reproducible
even against itself.

A wind-excited resonator would normally use `noise`. This one does not.
The excitation is sample-and-holds latching slow oscillators at rates that
do not divide into each other. The same stone sounds the same for every visitor.
Per-stone variation comes from `spawn.rng`.

---

## Offline render

The same `ASLGraphDescriptor` that runs on this world's audio thread
renders in Node with no `AudioContext`, no worklet, and no browser:

```bash
node scripts/render-preview.mjs stones.wav
```

`src/materials/resonantStone.test.ts` asserts that a still day is quieter
than a gale, that a strike decays, that two stones with different seeds
are not the same audio, and that the whole thing is bit-identical across
runs.

That is a fourth host for the same graph: a browser tab, an offline
render, an AUv3 in a DAW, and a 3D world.

## Known edges

- **One decoration, one AudioMaterial.** The bridge is general; the world
  content is one use of it.
- **`getWeatherAt` speed is cloud drift**, which is the closest thing the
  engine exposes to a wind field. It is a stand-in, not a wind simulation.
- **Two crate plugins on one page would ship crate twice.** This one
  publishes its bridge as `window.CrateXR` so a second can reuse it, which
  also shares the single worklet-module load. There is no version
  negotiation beyond a `version` field.
- **Not tried in VR.** The engine switches to WebGL for XR sessions;
  nothing here touches rendering, but the audio path under an active XR
  session is untested.
