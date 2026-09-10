# Kernels

ASL describes per-sample maths. Some DSP is not that shape.

Neural inference runs a whole block through an engine. A granular voice
manager owns its own scheduling and produces a block from nothing.
Convolution needs a block to convolve. Expressing those as per-sample
expressions is the wrong shape.

So a Material's graph may name a **kernel slot**, and something binds real
DSP to it.

## Two shapes

**A seam** sits inside an otherwise ordinary graph. Everything upstream is
collected into a block, the kernel transforms it, everything downstream
reads the result.

```ts
graph: ({ input, params }) =>
  kernel.seam('acme.tape', input.mul(params.drive)).mul(params.output)
```

**A source** is the whole graph. It receives the input block and fills the
output block.

```ts
graph: ({ input }) => kernel.source('acme.granular', input, { fallback: 'passthrough' })
```

## Nothing bound is not an error

An unbound seam passes audio through. An unbound source honours its declared
fallback: `passthrough` for an effect, `silence` for an instrument.

## The constraint

**The set of kernels a renderer can run is fixed when that renderer is built.**

The audio thread runs in an isolated context with no dynamic imports. A
running worklet cannot be handed new code. Installing a package gets you
the main-thread half of a Material. The audio-thread half has to already
be inside a bundle compiled before the page loaded.

Audiocrate has two answers.

## Express it in ASL

A graph is data, and data crosses the boundary without a build step. **Every
piece of DSP expressible as ASL nodes needs no kernel at all.**

The core node library is large for that reason. The more ASL can express,
the fewer Materials need a kernel.

## Ship it as data

An audio thread cannot import code. It can build a module from **bytes** it
is handed. A portable kernel is a freestanding compiled module plus a
plain-data descriptor, and the glue lives inside crate's own renderer:

```ts
await voice.loadKernel('acme.tape.kernel', {
  binary,                       // the module, as bytes
  descriptor: {
    abi: 1,
    name: 'acme.tape',
    mode: 'seam',
    params: { drive: 0, tone: 1 },   // parameter name to integer id
    latencySamples: 0,
  },
  params: material.snapshotParams(),
});
```

The renderer has no factory registered under that name, sees a portable
payload, and loads it. Nothing was rebuilt.

A portable kernel cannot be arbitrary JavaScript. Installing a Material
does not run its author's code on the audio thread.

### The interface, version 1

A module exports its memory and:

| Export | Signature | |
|---|---|---|
| `crate_abi_version` | `() -> i32` | must return 1 |
| `crate_init` | `(sampleRate: i32, maxFrames: i32) -> i32` | returns a nonzero handle |
| `crate_input_ptr` | `(handle, channel) -> i32` | byte offset of a block, 0 for no such channel |
| `crate_output_ptr` | `(handle, channel) -> i32` | same |
| `crate_process` | `(handle, frames) -> void` | |

Optionally: `crate_set_param`, `crate_note_on`, `crate_note_off`,
`crate_all_notes_off`, `crate_control_change`, `crate_set_bpm`,
`crate_latency`, `crate_dispose`.

Notes:

- **Pointers must be nonzero**, because zero is how a module says a channel
  does not exist.
- **Pointers are read fresh every block**, so a module may move its buffers,
  and the views are rebuilt if a module grows its memory.
- **Parameters cross as integer ids**, declared in the descriptor. A name
  would have to be written into the module's memory; an integer is something
  every toolchain can pass.
- **Blocks longer than `maxFrames` are chunked**, never truncated.

### What a kernel is allowed to reach

**One import, which throws.** No console, no clock, no random source, no
imported memory.

The import surface is the capability surface. A kernel that wants noise
brings its own generator. A kernel with no access to a clock or a random
source produces the same output for the same input, every time.

### Writing one

[`examples/portable-kernel/`](../examples/portable-kernel/README.md) is a
complete example: C, one clang invocation, an 861-byte module, and a test
that loads it through the same factory a third-party Material would.

```bash
cd examples/portable-kernel && ./build.sh
```

The flags that matter are `-nostdlib -ffreestanding --no-entry
--export-memory`. **Not emscripten**, which emits a module plus a JavaScript
loader that expects a DOM and a filesystem, and an AudioWorklet has neither.
Any language that compiles to freestanding wasm will do: Rust with
`#![no_std]` on `wasm32-unknown-unknown`, Zig with
`-target wasm32-freestanding`, or hand-written wat. Audiocrate loads a module,
not a language.

The example's README walks through five consequences of the constraint: no
math library, no allocator, zero is not a valid pointer, refusing beats
clamping, and exact unity at the bypass setting.

### A minimal reference

`crate/testing` also exports a conforming module assembled byte by byte with
no toolchain involved: one memory, one mutable global, six exported
functions, and a single import that is never called. Start from the C
example. Use this to check the host wiring.

## Getting the bytes there

A plugin can fetch its own module from a URL it resolves relative to itself:

```ts
async bindLiveVoice(voice, material) {
  const binary = await fetchKernelBinary(new URL('./tape.wasm', import.meta.url).href);
  await voice.loadKernel(TAPE_SLOT, { binary, descriptor, params: material.snapshotParams() });
}
```

`fetchKernelBinary` shares one request per URL, including requests already
in flight, because a live scene calls `bindLiveVoice` once per voice. A
failed fetch drops its cache entry rather than poisoning the session.

## Building a renderer with kernels compiled in

For DSP that cannot be portable, a host composes its own renderer build:

```ts
// my-audio-worklet.ts
import { defineCrateVoiceProcessor } from 'audiocrate';
import { tapeKernelFactory } from './tapeKernel';

defineCrateVoiceProcessor('crate-voice-processor', {
  'acme.tape.kernel': tapeKernelFactory,
});
```

Point your bundler at that file instead of Audiocrate's own entry. Audiocrate's
default build carries only the primitives that belong in every renderer.

Registering a Material and building its kernel into the renderer are two
halves of one thing. Registering without the kernel means every load fails.
Building the kernel in without registering means saved projects never map
onto it.

## Anything that is not a number

Parameters cross as numbers. An impulse response, a sample table, or a
preset blob does not, so there is a second channel:

```ts
voice.sendKernel('acme.convolver', { type: 'setIR', samples });
```

which arrives at the kernel's `onMessage(message)`. The worklet queues
messages for a kernel that has not finished loading, so a host may post them
in the same turn as `loadKernel` without racing it.

**Portable kernels cannot receive these.** A wasm module's imports are its
whole capability surface and a structured message is not something an
integer signature can carry, so `onMessage` only exists for a kernel
compiled into a renderer build. A portable kernel is configured entirely by
numbers. DSP that needs a buffer handed to it (a convolver is the obvious
case) needs a composed renderer build. Audiocrate's IR convolver ships inside
the renderer for that reason.

## Reporting

A kernel may describe itself, and that description is returned when it
becomes ready:

```ts
describe() {
  return { architecture: 'wavenet', fastPath: true };
}
```

A `describe()` result is how a host tells a fast path from a fallback. A
kernel that silently took the slower path is a performance regression with
no other symptom. A test that only asserts nothing threw will not catch it.

Kernels may also report measurements alongside a Material's taps, at the
rate the host asked for, never per block. Keep that to reading state the
kernel already has. Analysis that needs real work belongs on the main
thread.

## What is missing

- **Arbitrary JavaScript kernels still need a custom renderer build.** This
  is the one distribution case with no other path.
- **A compiler from ASL to a compiled kernel.** ASL runs through an
  interpreter. The public API would not change if that were replaced.
- **Portable kernels cannot declare their own parameter schema.** The
  Material declares parameters; the descriptor only maps them to ids.
- **Portable kernels cannot be sent anything but numbers.** No `onMessage`,
  so no impulse response, no sample table. This is the constraint most
  likely to push a third-party kernel into needing a composed renderer
  build, and the most likely candidate for the next version of the ABI.
