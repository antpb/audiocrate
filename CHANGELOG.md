# Changelog

## 0.1.0

First public release.

### Known issues

- The conformance gate renders only **fixed** parameters. It cannot see a
  node that is correct at every constant value and clicks when the value
  moves. A separate test covers the delay and comb cases that had that bug.
- Mobile voice budgets are estimated, not profiled.
- The kernel path has one shipped implementation.
