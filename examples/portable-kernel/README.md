# A portable kernel, start to finish

Most DSP does not need one of these. Anything expressible as ASL nodes
crosses into the audio thread as data and installs with no build step. 107
of the 108 AudioMaterials crate ships have no kernel. Use this when DSP is
block-shaped: neural inference, a granular voice manager, a partitioned
convolver. A biquad is not block-shaped. A tremolo is not either. The one
here is a tremolo because the interesting part of this example is the
packaging.

Read [`docs/kernels.md`](../../docs/kernels.md) for why the constraint
exists. This is the build.

## The files

| | |
|---|---|
| `tremolo.c` | The kernel. Freestanding C, no libc, no imports |
| `build.sh` | One clang invocation |
| `tremolo.wasm` | The built artefact, checked in so the test needs no toolchain |

The test that loads it is
`test/renderers/kernels/portableKernel.example.test.ts`. It uses the same
`wasmKernelFactory` a third-party AudioMaterial would, so if the instructions
below stop producing something crate can load, a test goes red.

## Build it

```bash
./build.sh                       # or: CLANG=/opt/homebrew/opt/llvm/bin/clang ./build.sh
```

861 bytes.

You need a clang whose `--print-targets` lists `wasm32`. Xcode's clang does
not. A Homebrew `llvm`, a swiftly-managed toolchain, or the wasi-sdk does.

**Not emscripten.** Emscripten emits a module plus a JavaScript loader that
expects a DOM and a filesystem, and an AudioWorklet has neither. The flags
that matter are `-nostdlib -ffreestanding --no-entry --export-memory`: no
standard library, no `main`, and the memory exported so crate can write
blocks into it.

Any language that compiles to freestanding wasm works. Rust with
`wasm32-unknown-unknown` and `#![no_std]`, Zig with `-target
wasm32-freestanding`, or hand-written wat. Audiocrate loads a module, not a
language.

## Load it

```ts
const binary = await fetchKernelBinary(new URL('./tremolo.wasm', import.meta.url).href);

await voice.loadKernel('example.tremolo', {
  binary,
  descriptor: {
    abi: 1,
    name: 'example.tremolo',
    mode: 'seam',
    params: { rate: 0, depth: 1 },   // AudioMaterial param name -> the id the C switches on
    maxFrames: 128,
  },
  params: material.snapshotParams(),
});
```

The AudioMaterial's graph names the same slot:

```ts
graph: ({ input }) => kernel.seam('example.tremolo', input)
```

Audiocrate's worklet has no factory registered under that name, sees a descriptor
in the payload, and loads it as a portable kernel. Nothing was rebuilt.

## What the C file is demonstrating

Five things, all consequences of "the audio thread cannot import code":

**No math library.** `sin` is not available and linking one would stop the
module being freestanding, so the LFO uses a parabola through the same zeros
and peaks. It is off by about one percent, which is inaudible in a gain
modulator and would be unacceptable in an oscillator.

**No allocator.** Buffers are static and sized at compile time. A kernel
that cannot allocate is a kernel that cannot stall.

**Zero is not a pointer.** `crate_input_ptr` returns 0 to mean "no such
channel", which is how a mono kernel declines a right channel. A buffer
may therefore never live at offset zero, and a module whose first allocation
lands there will read as absent.

**Refusing beats clamping.** `crate_init` returns 0 when asked for blocks
larger than the module can hold. Clamping instead would process the first
1024 frames of every block and pass the rest through untouched, which
sounds like a subtle bug rather than a loud one. `loadKernel` rejecting is
how the author finds out.

**Exact unity at the bypass setting.** Depth zero multiplies by exactly
1.0, so a bypassed tremolo is bit-identical to no tremolo. "Almost unity"
is how a chain of nominally-bypassed inserts loses a decibel, and it is
pinned by a test.

## What the constraint buys

The module imports nothing. Not a console, not a clock, not a random source.
That is the capability surface:

- **Installing an AudioMaterial never means running its author's code in your
  audio thread.** A wasm module with no imports cannot reach your page.
- **A render is reproducible.** A kernel with no clock and no random source
  produces the same output for the same input, every time.

A kernel that wants noise brings its own PRNG.

## Where this stops

A portable kernel cannot declare its own parameter schema; the AudioMaterial
declares parameters and the descriptor only maps them to ids. DSP that will
not compile freestanding, or that is arbitrary JavaScript, still needs a
composed worklet build.
