# CrateC

The third ASL interpreter, in C99, for hardware.

`asl/compile.ts` is the reference and [`CrateASL`](../CrateASL/) is the
Swift twin. This is the same interpreter written for a target with no
operating system to lean on: no allocation on the render path, no strings
hashed per sample, and a plan a device can execute straight out of flash.
The first target is a Sonicake Pocket Master (MVSilicon BP1048).

```bash
make conformance         # the gate: 115 cases against the JS reference
make pack                # the factory library as build/factory.pack
make smoke               # every patch in the pack, loaded and listened to
```

## What is proven

**Conformance.** The fixture both other implementations are held to
(`fixtures/asl-conformance.json`), rendered by the C interpreter with
`double` evaluation and float delay lines:

```
cases            115, 55 stereo
bit-exact        113
worst deviation  7.45e-09 (delay)
tolerance        5e-06
```

Every node kind in `ALL_NODE_KINDS` decodes, and the runner fails if the
fixture's vocabulary and `crate_kind_names` disagree in either direction.

**The factory library on the device path.** `make smoke` loads every patch
through `crate_engine` (the API a firmware calls) with the device's types
(float evaluation, int16 lines), a 128 KB arena, 4 voices and mono input,
and holds each one to the bars `validate-factory.sh` holds the iOS AUv3 to:

| Slot | Bar |
|---|---|
| instrument | held middle C peaks at 0.18 or more; a four note chord on one voice peaks at 1.6 or less |
| either (plays itself) | still sounding after its first second, transport rolling |
| effect | a 0.30 saw at 110 Hz comes out between 0.06 and 0.75 |

82 of 100 fit the budget and all 82 pass. The other 18 are listed but
marked unavailable (below).

## What is measured, not proven

**Float evaluation.** `make conformance-float` runs the same fixture with
`CRATE_REAL_FLOAT`. Signal paths stay within about 1e-4 (filters,
oscillators, mixes) and envelopes within about 1e-2. Event nodes (clocks,
pulses, sequencers, euclidean) land an edge one sample (21 us) early or
late, which reads as a deviation of 1 on a 0/1 signal; noise colour and
the quantizer differ when an input sits on a rounding boundary. None of it
is audible, and none of it can be held to 5e-6, so the float build is
reported, not gated.

**Cost.** `cratesim --smoke` times each render as a multiple of real time
on the build machine. That ranks patches; it says nothing absolute about
a 320 MHz core without an FPU confirmation.

## The memory policy

A delay line is declared with a maximum time chosen for a desktop, often
seconds. `cratepack` bounds what each line can actually be asked for by
interval arithmetic over the subgraph feeding its time input: the
published range of every parameter, and the tempo range the pack is built
for (`--bpm-min`, `--bpm-max`, which the engine then clamps its transport
to). The line is sized to that bound. It is an upper bound, so no setting
of any control reads past the end of a fitted line, and the sound is
unchanged. Thirty patches got smaller this way, 67.5 seconds of line in
all, which is what brings the reverbs and pads to 56 to 96 KB.

On top of that:

- Audio lines are int16 on a device (`CRATE_LINE_INT16`), at a fixed scale
  with headroom to +-4 so feedback above full scale is held, not clipped.
- With `mono_input`, a stereo insert that would only mirror its left
  channel does not reserve its right channel's lines.

Whatever still does not fit is marked unavailable in the pack and refused
by `crate_engine_load`, never shortened. At 128 KB those are the patches
whose controls really do reach seconds: slapback, chorus and vibrato
(0 to 2 s), the tempo-synced echoes at the slowest tempo, and five
instruments that run a delay per voice.

## Layout

| | |
|---|---|
| `include/crate.h`, `src/crate.c` | Plan format, voice state, every evaluator |
| `include/crate_pool.h`, `src/crate_pool.c` | `VoicePool`: allocation, retirement, split instruments |
| `include/crate_pack.h` | A library of plans in one blob, with names, roles, CC params and footprints |
| `include/crate_engine.h`, `src/crate_engine.c` | The device API: one pack, one loaded patch, MIDI in |
| `include/crate_ble_midi.h`, `src/crate_ble_midi.c` | BLE MIDI packets to plain MIDI bytes (`make ble-midi`) |
| `host/crate_build.c` | Graph JSON to plan blob (`buildPlan`). Host only (and the web build) |
| `web/` | The browser build: WASM kernel, its worklet glue, the homecrate plugins |
| `host/cratepack.c` | Compiled documents to a pack: fits lines, measures footprints |
| `host/cratesim.c` | The pedal on a desktop: list, smoke, render a WAV |
| `test/conformance.c` | `ConformanceTests.swift` for this implementation |
| `tools/emit-factory-compiled.*` | The factory library through `buildPluginDocument` |

`src/` is all a device compiles. Nothing under `host/`, `test/` or
`tools/` is linked into firmware, and a device never parses JSON.

## The plan

A single position-independent blob: header, a fixed-size node record per
graph node, and pools for child indices, numbers, tables and strings.
Every reference is an offset, so the bytes can sit in a heap buffer, a
const array, or memory-mapped flash executed in place. The builder does
everything `buildPlan` does in Swift: slots, modes, constants, tables,
random ranks, sorted param and port names, sends and the nested bus.

Doubles in the plan stay doubles whatever `crate_real` is, so one pack is
valid for a double and a float build.

## The device contract

```c
crate_engine_init(&engine, &config, pack, pack_size, arena, arena_bytes);
crate_engine_request(&engine, index);              // any task
crate_engine_midi(&engine, CRATE_MIDI_USB, bytes, n); // that source's task
crate_engine_process(&engine, in_l, NULL, out_l, out_r, frames); // audio task
```

MIDI follows the iOS crate AU: notes play the pool (velocity / 127, a
zero-velocity note on is a note off), CC n glides the parameter whose
`address` is n across its published range, CC 120 and 123 release every
voice. Start, Continue and Stop drive the internal transport. A BLE MIDI
characteristic value goes to `crate_engine_ble_midi`, which strips the
packet header and timestamps (running status and SysEx continuation
included) whether it came from a keyboard or a phone.

A patch change is applied at the top of the next block, which renders
silence. Nothing loaded is a wire, never a mute.

Two settings, changeable while audio runs:

- **Output safety**, on by default. The identity below -1 dBFS, a soft knee
  toward full scale above it, and silence for a non-finite sample. Fifteen
  factory instruments pass the iOS gate and still exceed full scale when
  four voices sum; through this stage none do, and a patch that never
  reaches the knee is bit-identical to running without it. `--smoke`
  measures patches with it off, so it cannot hide a runaway or a NaN.
- **Dry under instruments**, off by default as on the iOS instrument slot:
  mixes the input under an instrument patch so a guitar plugged into a
  synth patch is still heard.

## On the web

`web/build.sh` compiles the runtime and the plan builder to WASM
(`web/dist/crate_web.{js,wasm}`, emscripten). `web/crate_web.c` is the whole
API: create a handle from a compiled graph's JSON (an instrument is a
`crate_pool`, an effect a `crate_state`), set params by name (the voice and
bus plans' params as one table), notes, transport, and `crateweb_process`
on 128-frame blocks. `web/src/kernel.ts` is the AudioWorklet kernel around
it and `web/src/plugin.ts` the homecrate plugins that load it. The build is
double evaluation with float lines, the conformance types, so the browser
plays what the reference plays; `test/patcher/crateKernel.test.ts` in the
package holds it to the JS interpreter sample for sample.

## Not yet

- **Bound kernels.** Unbound seams pass through and unbound sources take
  their fallback, which is the contract the fixture pins. No factory
  patch binds one.
- **The per-frame schedule** (`Schedule.swift`). A speed-up; the value
  cache makes evaluation order unobservable, so the recursive walk is the
  same audio.
- **A split instrument rendering its own bus as a single voice.** The
  pool runs the bus, which is the only host that needs it.
- **Pack size.** 951 KB for 100 patches, most of it the dense 52-entry
  input table each node carries. A sparse encoding would cut most of it.
