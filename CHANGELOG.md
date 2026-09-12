# Changelog

## Unreleased

### Added

- **Block-rate evaluation of parameter-only subtrees.** A subtree built from
  pure operations whose leaves are parameters and constants is computed once a
  block instead of once per sample per channel. Rendered output is unchanged,
  which the golden-audio snapshot checks sample for sample.
  `CompiledVoice.blockConstantNodes` reports how much of a graph qualifies.
- `ASLValue`, `ASLValueLike` and `SampleBox` are exported as types, so a
  package writing its own ASL helpers can declare what they take and return.

### Changed

- `panLaw` caches its gain per pan position rather than computing a sine and a
  cosine per sample.

## 0.1.0

First public release.

### Known issues

- The conformance gate renders only **fixed** parameters. It cannot see a
  node that is correct at every constant value and clicks when the value
  moves. A separate test covers the delay and comb cases that had that bug.
- Mobile voice budgets are estimated, not profiled.
- The kernel path has one shipped implementation.
