# Drum

A 16-pad sampler as one ASL graph. No kernel, no WASM, no worklet entry.

```ts
import { registerAudioMaterial } from 'audiocrate';
import { drumPlugin } from './src/index';

registerAudioMaterial(drumPlugin);
```

Amp, grain, synth and space-reverb are C++ kernels with a TypeScript wrapper.
This one is the other experiment: take a shipping AUv3 and write its DSP in
the graph language instead, then measure what that cost and what it could not
say. `dsp/` is the AUv3's own kernel, vendored as the specification.
`src/reference/` is a line-by-line TypeScript port of it, and `parity.test.ts`
holds the graph to that port stage by stage.

## Signal path

```
note 36..51 -> pad 0..15
  sample playback (linear interp, rate = 2^(semis/12))
  -> bit crusher   (bits + sample-rate reduction)
  -> bit trim      (under 8 bits)
  -> low-pass      (Cytomic SVF)
  -> x volume x velocity x equal-power pan
  -> sum
     -> master low-pass   (18 dB/oct, 1-pole into biquad)
     -> character         (the plugin's own IR, run as a filter)
     -> master volume
```

## What the language could say exactly

Each of these is an identity, not a resemblance. The test file names the
tolerance each one actually holds to.

| Stage | How |
|---|---|
| Bit reduction | The AU rounds `(x/2 + 1/2) * 2^b` and maps back, which reduces to rounding `x * 2^(b-1)` and dividing by it. That is `bitcrush` as crate defines it: same node, same bit count. |
| Truncation (8 bits and under) | The same grid shifted down half a step. `bitcrush(x - 2^-b)`. |
| Sample-rate reduction, harsh mode | `sampleHold` is a phase accumulator ticking at `freq / sampleRate`, which is the AU's raw hold exactly. The translation is passing the hold rate in hertz. |
| Noise floor gate | Rectify, scale by `2^bits`, clamp, crossfade. |
| Per-pad low-pass | Cytomic's SVF and the cookbook biquad are two discretisations of the same prewarped bilinear prototype, and the SVF's damping K is the biquad's `1/Q`. So it is `filter.lowpass` with `q = 1/(2 - 1.9 * res)`. |
| Master biquad stage | `filter.lowpass` is the same cookbook design `CascadeFilter::calcLP` writes out by hand. |
| Master 1-pole stage | Not a node, but buildable. `delay` at one sample has an integer read pointer and a feedback path that is exactly `s[n] = x[n] + a*s[n-1]`; the numerator is one multiply-add and a sum. |
| Equal-power pan | `panLaw` is already the AU's law, angle `(pan + 1) * pi/4`. |
| The character IR | `synthesizeDefaultMasterIR` runs an impulse through an 18 dB/oct low-pass at 17 kHz and convolves with the result. Convolving with a filter's impulse response is running the filter, so the wet path is that cascade again and no convolution is needed. `reference/characterIr.test.ts` checks the identity holds to 1e-6 at the AU's 1024-sample truncation. |

The last one is the nicest result in the package. A stage that looked like it
needed an FFT needed a filter.

## What it could not

| | |
|---|---|
| The clean-mode hold | Above 8 bits the AU smooths each hold transition with a polyBLEP correction that carries into the next sample. The correction needs the fractional position of the phase wrap, which lives inside the hold node, and a one-sample carry back out of it. Measured: 0.70 peak difference, of which most is a one-sample lag (the AU emits last sample's carry). Aligning that leaves 0.31, which is the smoothing itself. |
| A user-loaded IR | There is no convolution in ASL and no way to write one: an FIR of a thousand taps is a thousand unit delays. The preset's IR filename is carried and not applied. |
| The convolver's latency | The AU buffers a whole 512-sample partition before it emits anything, so its wet path lags the dry one by `partition - hostBlock` samples. That is a property of the wrapper, changes with the host's block size, and is not reproduced. |
| The AU's early-outs | Bypassing the pad DSP freezes the pad filters; a zero IR mix skips the IR pass entirely. `select` evaluates both branches, so here both sides always run and state stays warm. Inaudible except on the sample you toggle. |

## Primitives that had to be recovered

None of these needed a change to crate. All of them are worth knowing about,
because every one was a surprise on the way in.

| Missing | Recovered as |
|---|---|
| Division by a signal | A transfer curve for a seed, refined by Newton-Raphson. `y(2 - xy)` squares the error each step, and multiply and add is all it needs. `reciprocal` in `drumDsp.ts`. |
| Any exponential | `toFrequency` is one with the wrong constants folded around it: `pow2(x)` unwraps them. |
| `tan` | The Pade [3/3] approximant, which is what the AU's own SVF uses instead of calling `tanf` on the audio thread. |
| The sample rate | Nothing in a graph can ask. The bit crusher's knob runs from about 1 kHz up to the engine rate and the master filter's unit delay is one sample, so `createDrumMaterial({ sampleRate })` takes it the way the AU's `initialize` does. |
| The gate, as a value | An envelope with no times. `env.dahdsr({ attack: 0, decay: 0, sustain: 1, release: 0 })` reads the same `state.gate` and reports 0 or 1. |
| A latch | The same envelope with a very long release, which is how each pad keeps the velocity it was struck with while another pad is hit. |
| Choosing a pad | Not recovered. See below. |

Two type exports were added to crate for this package: `ASLValue` and
`SampleBox`. A package writing its own ASL helpers can build graphs without
them but cannot declare a function that takes or returns one.

## The cost

The AU has sixteen playheads and a loop that skips the idle ones. A graph has
no control flow and no way to index a sample bank or a parameter by a value, so
a pad cannot be chosen, only compared against: all sixteen branches run on
every sample, and because pads pan, the whole tree runs twice.

That first measurement is what prompted `blockConstantNodes`. **1579 of this
graph's 2014 nodes are coefficient arithmetic over parameters**, which has the
same answer for every sample in a block, and the evaluator was recomputing all
of it per sample per channel. It now evaluates a parameter-only subtree once a
block. Nothing about the rendered signal changed, which the golden-audio
snapshot checks; what changed is the price.

Measured on one laptop, so read the ratios rather than the absolute numbers
(`drumCost.test.ts`, `--reporter=verbose`):

| | Nodes | Block constant | Before | After |
|---|---|---|---|---|
| Whole instrument | 2014 | 1579 | 0.25x real time | 0.71x |
| 16 sample players | 33 | 16 | 25.8x | 32.3x |
| 16 bit crushers | 1091 | 834 | 0.83x | 3.1x |
| 16 pad low-passes | 323 | 290 | 5.0x | 18.0x |
| 16 pans | 98 | 17 | 4.3x | 5.1x |
| Master chain | 168 | 155 | 10.5x | 55.3x |

Only the pan stage reads the channel index, so only that one is evaluated
twice per sample in the table; the whole instrument is, which is why its
figure sits below every stage in isolation.

Two changes went with it, both in the evaluator and both invisible in the
output. `panLaw` caches its gain the way every filter here caches its
coefficients, because a pan that is not moving was otherwise a sine and a
cosine per sample per pad per channel. And the crusher's harsh mode became an
offset on the input rather than a second crusher and a choice between them,
which moved the mode decision to block rate and left one node on the audio
path.

What is left is structural. The pad chain up to the pan produces the same
numbers on both channels, because `samplePlay` reads one channel of its
buffer, and it is computed twice anyway: evaluation is per channel for the
whole graph, and there is no way to mark a region of it mono. Closing that
would roughly halve what remains.

## Against the kernel route

| | Kernel (amp, grain, synth) | Graph (this) |
|---|---|---|
| Build step | emscripten, a `.wasm`, a fixtures directory | none |
| Worklet | needs an entry in the bundle | nothing to add |
| Editor | needs a `kernels.ts` binary fetch | nothing to add |
| Fidelity | exact, it is the same C++ | exact but for the polyBLEP hold and user IRs |
| Cost | C++ speed | 0.71x real time, and see above |
| Inspectable | a binary | an object you can print, diff and serialise |

## The factory kit

A drum with sixteen empty pads makes no sound however hard it is played, and
the AUv3 and the VST3 both seed a kit when a fresh instance is added. So does
this. `drumKit.ts` is that kit as data: the shipping per-pad values from the
host's `homecrateDrumDefaultKitState`, the pad labels, and the pad-to-file
map. Eleven of the sixteen pads come off five recordings, retuned by the
per-pad pitch.

Loading is the caller's, because where the files live is the host's business:
the plugin reads an App Group sample library, and the editor imports
`assets/` as bundled URLs the way it does the factory NAM profile. A drum with
even one pad loaded is left alone, so nothing anyone built is overwritten.

`assets/` is the shipping kit at a third of the bytes, built by
`assets/build-kit.mjs`. Two changes, both because of what actually gets
played: mono, since `samplePlay` reads one channel of its buffer and a stereo
asset has a side that can never be heard, and 16-bit, which is not reachable
through a bit crusher whose job is to throw away depth.

## Not implemented

Declared so a kit round-trips, read by nothing, listed by `INERT_PARAMS`:
per-pad stretch (an offline SOLA pass in the AU's Swift, not in `dsp/`),
Character and Humanize (velocity and timing perturbation at note-on), and the
per-pad sample stop and fade points (playhead-relative, and the sample player
node has no input for them). The editor panel groups them under a heading that
says so.

Also absent: the AU's sequencer, its sample-record flow, and host transport
follow. Those are the plugin's, not the instrument's.

## Layout

```
dsp/        the AUv3 kernel, vendored. The specification. Nothing compiles it
params/     the AUv3 parameter address enum, checked against in the tests
src/        the material, the graph, and the preset decoder
src/reference/   the same DSP in TypeScript, for the parity tests
```

Copy provenance is in `SOURCE.txt`.

## Tests

```bash
npx vitest run --config examples/drum/vitest.config.ts --dir examples/drum
```

`parity.test.ts` is the interesting one. Every bound in it is a measurement
rather than a target: a stage that matches to float precision is asserted at
float precision, and a stage that does not is asserted at the error it actually
has with the reason beside it.
