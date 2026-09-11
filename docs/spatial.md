# Spatial

Placing sound in three dimensions, in the browser, with the positions
automatable at audio rate.

```bash
npm install audiocrate
```

## Why not one panner per source

Putting one sound to your left is easy: the platform has `PannerNode`. Putting
forty sounds in a room, turning the listener's head, and exporting the result
is where it stops being easy.

Panning each source individually means every source pays for its own
head-related filtering, and turning the listener means recomputing every
source's position. Worse, the moment you want to write the result to a file,
there is nothing to write: the spatial information only ever existed as forty
separate pan decisions.

## Ambisonic bus

A spatial source does not output sound you can listen to. It outputs
**direction**, as four channels of first-order ambisonics.

```
[synth]   -audio->  [SpatialSource]  -4ch->  \
                       x  y  z                \
[sampler] -audio->  [SpatialSource]  -4ch->  --  [SpatialBus]  -stereo->  out
                       x  y  z                /    yaw  pitch
[voice]   -audio->  [SpatialSource]  -4ch->  /     decode
```

Summing two sources is adding four channels. So the bus needs no registry of
what is connected and no side channel to learn where anything is: the cable
already carries it.

Everything downstream is then paid for once. One rotation serves any number of
sources, and so does one decode.

## Placing a source

```ts
import { crateWorkletUrls, FOA_ENCODER_PROCESSOR, SpatialBus } from 'audiocrate';

const ctx = new AudioContext();
for (const url of crateWorkletUrls()) {
  try { await ctx.audioWorklet.addModule(url); break; } catch { /* next scheme */ }
}

const bus = new SpatialBus(ctx);
bus.output.connect(ctx.destination);

const source = new AudioWorkletNode(ctx, FOA_ENCODER_PROCESSOR, {
  outputChannelCount: [4],
});
source.parameters.get('x')!.value = 1;   // a metre to the right
source.parameters.get('z')!.value = -1;  // and a metre ahead

myAudio.connect(source);
source.connect(bus.input);
```

Position is cartesian, in metres, in the same frame the rest of audiocrate
uses: **+x right, +y up, -z front**. `NAMED_POSITIONS` has the eight presets
if you want them, and `sphericalToCartesian` converts if you think in angles.

## Why the position is an AudioParam

Because this works:

```ts
const lfo = ctx.createOscillator();
lfo.frequency.value = 0.5;
lfo.connect(source.parameters.get('x')!);
lfo.start();
```

The source now sweeps a metre either side of wherever you left it, sample
accurately, with no messages and no scheduling.

That is the reason the encoder is a worklet rather than a few `GainNode`s.
Four multiplications is all an ambisonic encode is, and a gain could do each
one. What a gain cannot do is derive those four numbers from a position: the
mapping normalizes by `1/|p|` and applies distance attenuation, both
nonlinear. The alternative is to compute the gains on the main thread and
schedule them, which caps the modulation at whatever rate your update loop
runs. For a drifting source that is fine. For an LFO it is a staircase.

## Testing listener rotation

AirPods head tracking is a system feature on Apple platforms
(`AVAudioEnvironmentNode.isListenerHeadTrackingEnabled`). JavaScript cannot
read it. WebXR is also absent on desktop Safari.

| How | Where | What you turn |
| --- | --- | --- |
| Drag the look pad on a Spatial Master | Editor | Your view |
| **Use device motion** on that panel | A phone or tablet | The device |
| An LFO or automation into the master's `yaw` | Anywhere | The field, on its own |
| `isListenerHeadTrackingEnabled` | Native app only | Your head |

Select a Spatial Master for a compass you can drag. On a phone, **Use
device motion** writes `yaw` and `pitch` from the orientation sensor.

Turn off Spatialize Stereo first (Control Center, under the volume slider).
If it is on, the OS applies its own head-tracked room on top of audio this
library already spatialized, and two rooms stack.

## Turning the listener

```ts
bus.setYawPitch(90);  // looking right
```

Yaw 0 looks down `-z` and positive yaw turns right, matching
`SpatialListener.setYawPitch`. This rotates the whole field with nine
coefficients, so it costs the same with one source connected or forty. Feed it
from `deviceorientation` or a WebXR pose for head tracking.

Rotation is control rate, deliberately: yaw reaches the coefficients through
`sin` and `cos`, so an audio-rate yaw would need its own worklet. A head turns
at human speed, and `setYawPitch` ramps rather than steps, so a per-frame pose
feed produces no zipper.

## Decoding

```ts
new SpatialBus(ctx, { decode: 'binaural' });   // the default
```

| Mode | Output | For |
| --- | --- | --- |
| `binaural` | stereo | Headphones. Six virtual speakers, each through a `PannerNode` with HRTF. |
| `stereo` | stereo | Speakers, and matching an exported fallback track. No HRTF. |
| `ambisonic` | 4 channels | Recording the field, or handing it to another decoder. |

`binaural` uses the browser's own head-related filtering rather than shipping
a set of measured impulse responses. That keeps audiocrate at zero runtime
dependencies and adds nothing to the download, and it means the cost is fixed:
six filters, whatever the source count.

The filtering is whatever the browser has, not Apple's and not a set tuned
to a particular headphone. A mix judged here will not match AirPods sample
for sample. `stereo` is the pan law an exported fallback track uses, so
that is the mode to check against a bounce. `ambisonic` is for recording
the field or handing it to another decoder.

## Omnidirectional sources

```ts
source.parameters.get('global')!.value = 1;
```

A `global` source has no direction: full width, immune to head rotation, no
distance attenuation. It is the bed, the narration, the thing that should not
move when the listener turns. In ambisonic terms it is the omnidirectional
component and nothing else, so this needs no separate code path.

## The origin is omnidirectional too

A source at exactly `(0, 0, 0)` has no direction to it, so it decodes as
omnidirectional rather than picking one arbitrarily.

`foaGainsFromPoint`, the offline function, returns a front-facing vector at
the origin (`Math.atan2(0, -0)` is `Math.PI`). Offline code marks an
omnidirectional source as `null` instead. A live position param that
crosses zero would flip direction and click if the encoder did the same.

## In the editor

**More > New spatial** loads a worked example. A clock plucks two combs
tuned a fifth apart, placed front left and ahead; an LFO moves the second one
along its `x` axis; a keyboard plays into a third source behind you to the
right; and a quiet brown-noise bed sits omnidirectionally underneath. All four
go to one Spatial Master, and a reverb after it.

Press Play, then turn the master's `yaw` and listen to everything except the
bed swing around you.

It uses short attacks because a head-related filter and an interaural delay
need a transient. A steady sine is hard to place front vs back.

The palette has **Spatial Source** and **Spatial Master** under `Spatial`.

Where the outlets go:

```
[anything] -audio-> [Spatial Source] -foa-> [Spatial Master] -audio-> [Master]
```

A Spatial Source's outlet is labelled `foa` and goes to a Spatial Master and
nowhere else. The master's outlet is ordinary stereo, so it goes to Master
like any other node. Several sources into one master is the normal case: that
is what the design is for.

A source's outlet only connects to a Spatial Master. Four-channel FOA into
an ordinary mixer folds to a phasey stereo pair.

Patch an LFO into `x`, `y` or `z` and the cable goes straight to the
`AudioParam`, at audio rate, rather than through the editor's control-rate
modulation path.

## What is not here yet

- **A position widget.** `x`, `y` and `z` are ordinary numeric params in the
  inspector today. A top-down drag surface is the next piece.
- **An orbit node.** An LFO on one axis sweeps a source past the listener. A
  circle needs two axes in quadrature, which needs a node with more than one
  control outlet, which the editor does not have a concept for yet.
- **Second order and above.** `encodeAmbisonics` throws on anything but order
  1. The encoder rejects anything else.
- **Near field and air absorption.** Distance is attenuation only, matching
  what the iOS app does today.
- **Head tracking wired to a device.** The rotation is there and takes any
  angle you give it; nothing yet reads a sensor for you.

## See also

- [`scene.md`](scene.md) for `scene.spatial`, the offline side: sources with
  automation lanes, and `export.toAmbisonics()`.
- [`materials.md`](materials.md) for the two node kinds as AudioMaterials.
