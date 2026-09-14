# Changelog

## Unreleased

## 0.2.0

### Added

- **Block-rate evaluation of parameter-only subtrees.** A subtree built from
  pure operations whose leaves are parameters and constants is computed once a
  block instead of once per sample per channel. Rendered output is unchanged,
  which the golden-audio snapshot checks sample for sample.
  `CompiledVoice.blockConstantNodes` reports how much of a graph qualifies.
- `ASLValue`, `ASLValueLike` and `SampleBox` are exported as types, so a
  package writing its own ASL helpers can declare what they take and return.
- **Reset on every node that carries a position in a pattern.** `clock`,
  `clockDivide`, `clockMultiply`, `euclidean`, and `sequencer` take an optional
  `reset`. A rising edge puts the node back to its first step. It is
  edge-triggered, so a Transport `playing` held high is one restart at Play
  and not a pattern pinned at step zero for the whole song. A clock fires on
  the sample it is reset. A divider is left one short of its factor so the
  next tick through is the one that fires. A multiplier forgets the interval
  it had learned. The inlet is added to a node only when it is asked for, so
  a graph that does not use it serializes exactly as it did. The matching
  AudioMaterials expose a `reset` jack, appended so existing flatten addresses
  stay put. Flatten treats `reset` as a per-note inlet, like `clock`.
- **LFO phase and reset.** `lfo({ phase, reset })` offsets where the shape is
  read without moving stored phase, so two LFOs at one rate can sit a quarter
  cycle apart and still be the same clock. Zero is exact: an unset or zero
  `phase` is bit-identical to the LFO that had no inlet. A rising `reset`
  restarts the cycle. `lfoMaterial` exposes both; `phase` is automatable.
- **Ladder drive.** `filter.ladder` and `ladderMaterial` take `drive`. It
  saturates into the filter. The default of 1 is a branch rather than
  `tanh(x) / tanh(1)`, so a ladder that already exists is exactly itself.
- **Sample and hold on another clock.** `sampleHold` and
  `sampleHoldMaterial` take a `clock` inlet. `freq` at 0 turns the internal
  rate off, which is what keeps two grids from fighting. An uncabled jack is
  still an input holding its default, so presence of the cable cannot be the
  switch.
- **Gate hold.** `gateMaterial` and `sidechainGateMaterial` take `hold`, the
  shortest time the gate may stay open once it has opened. It is a pulse-and-or
  in ASL rather than a second envelope in the kernel. At 0 the pulse is one
  sample wide and lands on the sample that already went high, so the or is
  exactly the old open signal.
- **Live amplitude envelope on `oscillatorMaterial`.** Attack, decay, sustain,
  and release were four numbers written into the graph. They are parameters
  now, defaulted to those numbers, built from `env.dahdsr` so a live value can
  reach them. SynthVoice and Wavetable already exposed theirs.
- Drum plugin example, factory kit, and pad editing in the patcher.
- Line / Mic device picker. Android Chrome lists USB audio but often still
  captures the phone microphone; the inspector now says what actually opened.
- A module dropped while Play is running joins the live graph. Stop and Play
  are no longer required to hear it.

### Changed

- `panLaw` caches its gain per pan position rather than computing a sine and a
  cosine per sample.
- `sampleHoldMaterial.freq` now runs from 0, and its curve is exponential.
  Zero means the external clock is in charge.

## 0.1.0

First public release.

### Known issues

- The conformance gate renders only **fixed** parameters. It cannot see a
  node that is correct at every constant value and clicks when the value
  moves. A separate test covers the delay and comb cases that had that bug.
- Mobile voice budgets are estimated, not profiled.
- The kernel path has one shipped implementation.
