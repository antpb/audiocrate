# Changelog

## 0.1.0

First public release.

Audiocrate has been in production use in one shipped application. This release
makes it installable as a package.

### The worklet no longer needs a bundler plugin

Previously `WebAudioRenderer` imported its processor as
`'./worklet/crate-voice-processor.ts?worklet'`. That is Vite plugin syntax.
Installing Audiocrate from npm and building with webpack, Next.js, esbuild, or
Rollup failed to resolve at build time.

The worklet is now bundled ahead of time and shipped two ways:

- **As a string**, the default. `crateWorkletUrls()` mints `blob:` and `data:`
  URLs at runtime and `WebAudioRenderer` tries them in order. Engines
  disagree about which schemes a worklet module may be fetched from, and a
  rejection surfaces as an opaque error. No plugin, no configuration, no
  build step.
- **As a file** at `audiocrate/worklet`, for hosts that want a cacheable
  asset and pass `workletUrl`.

It is reachable only from `WebAudioRenderer`, so an app that renders offline
or only uses the theory package tree-shakes all 91 KB of it away.

A test regenerates the bundle and compares it byte for byte, so a stale
generated file cannot silently ship the previous interpreter.

### `env.adsr` accepts the same option names as `env.dahdsr`

`env.adsr` took `{ a, d, s, r }` while `env.dahdsr` took
`{ attack, decay, sustain, release }`. The interpreter reads `params.a`
directly, so calling `adsr` with the long names emitted a node with no `a`
and rendered NaN: no error, no warning.

TypeScript caught this inside the repository. A JavaScript caller got
silence. Found by a consumer smoke test in plain JavaScript against the
packed tarball.

Both spellings now work and produce identical output. Unknown keys throw
instead of being ignored, so a typo like `atack` is a stack trace. A
non-finite time throws. The fix is in the builder: a correct call emits the
same node as before, and the golden audio snapshot and Swift conformance
fixture are untouched.

`env.adsr` still defaults its trigger to 0 and renders silence until a
velocity is bound with `.trigger(v)`. A default of 1 would let a Material
ignore velocity with no signal that it had.

### Collaboration

Continuous peer state (`set` / `peerState`) was already on the wire.
Discrete edits were reserved (`MESSAGE.edit`) and unused, and nothing bound
`SceneSync` to an `AudioScene`.

`sendEdit` now carries last-write-wins edits per target, ordered by
`(time, peerId, seq)`. A discarded write is not applied; `onConflict` fires
so a host can show it. `attachAudioScene` is the opt-in binding for
transport commands and the master mixer. Late joiners receive the accepted
edit set on first clock contact. Games still use `set` for per-peer avatars.

### Packaging

- Published as **`audiocrate`**, MIT licensed.
- Built output: ES modules with preserved module structure. Type
  declarations for everything.
- Subpath exports for `theory`, `hooks`, `collab`, `spatial`, and `testing`.
- Zero runtime dependencies.
- `crateWorkletUrls` and `CRATE_WORKLET_SOURCE` are exported from the barrel,
  for a host that loads the module into a context it owns.

### Known issues

- The conformance gate renders only **fixed** parameters. It cannot see a
  node that is correct at every constant value and clicks when the value
  moves. A separate test covers the delay and comb cases that had that bug.
- Mobile voice budgets are estimated, not profiled.
- The kernel path has one shipped implementation.
