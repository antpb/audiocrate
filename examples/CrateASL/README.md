# CrateASL

The ASL interpreter in Swift. Same graphs as `asl/compile.ts`, compared
sample by sample. Not in the npm package.

The gate, and the steps for adding a node kind, are in
[`docs/conformance.md`](../../docs/conformance.md).

```bash
cd examples/CrateASL
/usr/bin/swift test
/usr/bin/swift test -c release
```

Use `/usr/bin/swift`, not `swift`. A `swiftly` toolchain earlier on PATH
fails at link with `-no_warn_duplicate_libraries`.

The suite reads the fixtures next to this package
(`fixtures/asl-conformance.json` and the MIDI / tempo / clip / session /
plan files). Override a path with `CRATE_ASL_FIXTURE` (and the matching
`CRATE_*_FIXTURE` variables).

```
cases            91, 51 of them stereo
node kinds       71, 2 exempt
bit-exact        91
worst deviation  0.0
```

The asserted tolerance is 5e-6. Zero is what is currently measured.

## One rule for anything on the sample path

**Resolve names to a dense index when the plan is built. Never look one up at
render time.** `Plan.swift` already does this for `param`, `port` and tap
nodes, and the indices it writes onto `PlanNode` (`paramIndex`, `portIndex`,
`tapIndex`) are the only way those are addressed per sample.

A `Dictionary` keyed by `String` on that path is two defects wearing one coat.
It hashes a string at the sample rate, which is invisible in a browser and a
dropout in an AUv3. And it is a structure another thread can reallocate
underneath the read: an AUv3 sets a parameter on whichever thread the host or
the plugin's own view is on, so a dictionary being read per sample and written
from a slider is a wild pointer, not a stale number. Both of those were real
here, and the second one was a reproducible `SIGSEGV`
(`PortScalarRaceTests` is what it looks like from the outside).

The same rule covers lazy creation. A tap that allocated its accumulator on
the first sample through it was allocating on the audio thread; the slots are
built with the voice now, sized from `Plan.tapWindows`.

Per-instance state the host can replace belongs **inside** the object the
render block pins for its block, not beside it. A table the host rebuilds on
its own thread while the render thread reads it is the same bug even when
nobody calls it a cache.

| File | |
|---|---|
| `Graph.swift` | Graph document, `NodeKind` |
| `Plan.swift` | Slot assignment before the first sample |
| `State.swift` | Per-voice state, the `KernelProcessor` seam |
| `Interpreter.swift` | `CompiledVoice`, block render |
| `Nodes.swift` | Kind switch |
| `NodeHelpers.swift` | DSP |
| `MidiIo.swift` | MIDI In / Out |
| `TempoMap.swift` | Tempo map |
| `VoicePool.swift` | Instrument voices |

`noise` and `random` are exempt. Kernels are a seam here; bound DSP is
the kernel's own business.
