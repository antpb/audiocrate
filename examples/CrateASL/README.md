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
