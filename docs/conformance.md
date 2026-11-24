# Conformance

The same graph is supposed to run in more than one place: a browser, an
offline bounce, an AUv3, and the Android DAW. This document is how that is
checked. Android runs the TypeScript interpreter on Hermes. It is a host,
not an independent port. The cross-checks are JavaScript against Swift,
and JavaScript against C.

## What is proven, precisely

An ASL interpreter exists three times: `asl/compile.ts` in TypeScript, a
Swift port (`CrateASL`), and a C99 port for hardware (`CrateC`). 119 graphs
covering every node kind render in all three and are compared sample by
sample. The C port is held to the same fixture and tolerance with `double`
evaluation; its float build is measured, not gated (see
[`examples/CrateC`](../examples/CrateC/README.md)).

```
cases            119, 55 of them stereo
node kinds       71, none exempt
tolerance        5e-6
```

Bit-exactness is not the bar. V8 computes `Math.sin` with a bundled fdlibm
port and Swift calls Apple's libm. Two correct implementations of the same
function may disagree in the last bit. The asserted tolerance is 5e-6,
about 106 dB down, far below a 24-bit LSB.

Four caveats, all of which still hold:

1. **The interpreter, not the framework.** What is conformant is the signal
   path. The scene graph, timeline, clips, warp, automation, and project
   format are TypeScript only. A native host gets a voice, not a session.
2. **One sample rate.** The fixture is 48 kHz. Nothing asserts a graph is
   rate invariant, and a DAW may run at 44.1.
3. **The offline renderer is not an independent implementation.** It shares
   `compile.ts` with the worklet, so agreement there is true by construction.
   The JavaScript-to-Swift and JavaScript-to-C comparisons are the cross-checks.
4. **Android is a host, not an interpreter of its own.** `example-android/` runs
   the same `compile.ts` on Hermes, plus C++ kernels on Oboe because Hermes
   has no WebAssembly. On-device proof, not a second golden suite.

## The parts

| | |
|---|---|
| `asl/types.ts` | `ALL_NODE_KINDS`, the vocabulary as runtime data. `NodeKind` is derived from it |
| `asl/goldenCases.ts` | The graphs, the render recipe, and the exemption table |
| `test/asl/goldenAudio.test.ts` | Did any sample move, within one implementation |
| `test/asl/kindCoverage.test.ts` | Does every kind have evidence behind it |
| `asl/conformanceFixture.ts` | The fixture as a value, and its stamp |
| `test/asl/conformanceFixture.test.ts` | Is the file on disk still a description of this code |
| `fixtures/asl-conformance.json` | The graphs, the input, and the expected samples |
| `examples/CrateASL/Tests/CrateASLTests/ConformanceTests.swift` | Does the second implementation agree |
| `examples/CrateC/test/conformance.c` | Does the third implementation agree |

The vocabulary is an array rather than a bare union. A TypeScript union does
not survive to runtime, so nothing could ask "is every kind covered" without
a second list, and a second list drifts.

## Adding a node kind

Each step fails until you do the next one.

1. **Add the name to `ALL_NODE_KINDS`** in `asl/types.ts`.

   `npm run typecheck` now fails with `TS1360: Type '"yourKind"' does not
   satisfy the expected type 'never'` at the exhaustiveness check in
   `compile.ts`. The evaluator has to handle it.

2. **Implement it** in `asl/compile.ts`, and add a builder in `asl/builders.ts`.

   `vitest run` now fails in `kindCoverage.test.ts`: *"These node kinds
   render in no golden case, so no second implementation is held to them."*

3. **Add a golden case** to `sourceCases` or `insertCases` in
   `asl/goldenCases.ts`.

   Make it produce audio. A case that renders silence covers a kind on paper
   and asserts nothing, since two implementations agree on zero however they
   arrived at it, and there is a test that says so.

   `conformanceFixture.test.ts` now fails: the fixture on disk no longer
   describes this code, and it names your case under `added`.

4. **Regenerate the fixture:** `npm run fixtures:asl` from the repository
   root.

   The Swift suite now fails `testNodeVocabulariesAreIdentical`: *"kinds
   Audiocrate can emit that this interpreter cannot decode."*

5. **Add the case to `NodeKind`** in `examples/CrateASL/Sources/CrateASL/Graph.swift`.

   The Swift build now fails: the switch in `Nodes.swift` is exhaustive.

6. **Implement it in Swift**, then `/usr/bin/swift test`.

   The samples are now compared. If the two implementations disagree by more
   than 5e-6 the case is named with its worst deviation.

If you skip step 4, every later step is skipped with it and the Swift suite
reports full marks against the interpreter as it used to be. That is why
the fixture is compared rather than trusted.

## Running it

```bash
# from the repository root
cd packages/crate && npx vitest run     # includes the coverage and staleness gates
npm run fixtures:asl                    # only when you meant to change the fixture

# Swift suite (examples/CrateASL)
cd examples/CrateASL
/usr/bin/swift test                     # the cross-implementation comparison
/usr/bin/swift test -c release          # the same, plus a throughput number

# C (examples/CrateC)
make conformance                        # double, the same tolerance
make conformance-float                  # float, reported per case
```

**Use `/usr/bin/swift`, not `swift`.** A `swiftly`-managed toolchain earlier
on PATH links against a system `ld` that does not understand
`-no_warn_duplicate_libraries`, and the failure reads as a broken package
rather than a broken toolchain selection.

`CRATE_ASL_FIXTURE=/path/to/fixture.json` points the Swift suite at a
different file, which is how the gates themselves are tested.

## What the fixture carries, and why

- **Samples, not a digest.** A digest would fail on a last-bit libm
  disagreement, and chasing that would mean porting fdlibm before porting
  the interpreter. Deviation is a number; a digest is a boolean.
- **The first block and the last.** The first catches what only happens
  once: an envelope attack, a one-shot, an impulse. The last catches steady
  state, by which point every delay line has filled and wrapped. A fixture
  of only the last would call a dead one-shot and a working one identical.
- **Both output channels, from two different inputs.** A graph that reads
  `audio.right()`, or keeps per-channel state, is indistinguishable from one
  that does not when both sides are fed the same samples. Recording only
  channel 0 misses a stereo insert that collapses to mono.
- **A rolling transport.** Transport nodes are the one class of node whose
  value comes from outside the graph. Without a snapshot they all render
  against a stopped transport at beat zero, which proves the field names
  decode and nothing else.
- **The graphs as JSON.** This makes it a test of graph decoding too. An
  AUv3 receives a `crate.plugin` document, not a JavaScript object, and a
  decoder that fails to re-share a repeated node by id gives one filter two
  delay lines.
- **The whole vocabulary, not only the covered part.** The Swift side checks
  its own enum against this one directly.
- **A stamp.** FNV-1a over the content, so a stale file is one string
  mismatch rather than a diff of two megabytes of floats, and a hand-edited
  fixture fails.

## Seeded randomness

`noise` and `random` used to be the two exempt kinds: both called
`Math.random()`, so two runs of the same implementation disagreed and there
was nothing for a comparison to assert. They draw from seeded streams now
(`asl/rng.ts`, `Rng.swift`) and have golden cases like every other kind.
`COVERAGE_EXEMPT_KINDS` is empty and meant to stay so.

A stream is a pure function of three integers:

- the **voice seed**, `createState({ seed })` in JavaScript and
  `makeState(seed:)` in Swift, 0 by default;
- the node's **rank** among the graph's random nodes in structural order:
  first visit in a depth-first walk from the output, inputs in sorted name
  order, a `mix` list in order (`randomRanks`). Not the plan slot, because
  Swift walks inputs in dictionary order, and not the id, because the palette
  catalog renumbers ids and each language's flatten mints its own. The first
  version of this ranked by id; the flatten fixture compares ids only after
  renumbering, which is what showed that could not hold;
- the output **channel**, so the two sides of a stereo insert are two noises.

The generator is mulberry32 behind a murmur3 finalizer, all 32-bit wrapping
integer arithmetic, and a draw is that integer over 2^32. Both languages do
each step exactly, so noise is compared at zero tolerance. The fixture renders
at the default seed; `rng.test.ts` and `RngTests.swift` pin the same literal
draws at other seeds, ranks and channels.

Defaults, and why they differ by renderer:

| Renderer | Default seed | Why |
|---|---|---|
| `OfflineRenderer`, `BlockRenderer`, `compileVoice` | 0 | A bounce must be reproducible |
| `WebAudioRenderer.createVoice` | fresh random per voice | Two rain cells must not play one noise in lockstep |
| `AudioMaterial.bind(renderer, dest, { seed })` | voice `i` gets `seed + i` | A pool is reproducible and its voices still independent |
| Swift `VoicePool(seed:)` | the same rule | |

A host that wants a world to sound the same on every visit passes a seed
derived from its world seed and the emitter.

## What this does not cover

- **Sample rate.** One rate is tested. Every filter coefficient, every delay
  in seconds, and every envelope stage is a function of the rate. A patch
  that sounds different at 44.1 than at 48 is a bug in a node that no test
  here could find.
- **Kernels.** Only the *unbound* contract is pinned: a seam degrades to a
  wire, a source effect passes through, a source instrument is silent. What
  a bound kernel computes is that kernel's own business and is not ASL.
- **Anything above the signal path.** See the first caveat.
