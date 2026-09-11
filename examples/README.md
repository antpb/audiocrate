# Examples

Not in the npm package.

| | |
|---|---|
| [`portable-kernel/`](portable-kernel/README.md) | Freestanding wasm tremolo. The packaging walkthrough. |
| [`amp/`](amp/) | Neural amp and analog FX. The default editor patch uses this. |
| [`grain/`](grain/) | Granular engine |
| [`synth/`](synth/) | Wavetable / IR synth |
| [`space-reverb/`](space-reverb/) | Costello room |
| [`homecrate/`](homecrate/) | Registers the four kernels and ships the matching AudioWorklet entry |
| [`xr/`](xr/) | Crate as a `THREE.Audio` source, plus an XR Publisher plugin. `npm run example:xr` |
| [`CrateASL/`](CrateASL/) | Swift interpreter. The conformance twin. |

Core crate does not import these. The editor calls
`registerHomecrateMaterials()` and points Vite at
`examples/homecrate/worklet/homecrate-voice-processor.ts`.

```bash
npm install
npm run editor
```

http://localhost:5175
