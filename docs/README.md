# Docs

Library documentation for audiocrate. These pages assume
[the package README](../README.md). A rendered copy lives at
**<https://homecrate.app/docs/crate/>**.

Read **Philosophy**, then **Scenes and time**, **AudioMaterials**, and
**The Audio Shader Language**. The rest is one topic each.

| | |
|---|---|
| [Philosophy](philosophy.md) | Design rules and scope. Why the three.js split, and where audio is not graphics. |
| [Scenes and time](scene.md) | `AudioScene`, tracks, clips, transport, tempo maps. |
| [AudioMaterials](materials.md) | Parameter schema plus signal graph. Plugins, assets, inspection. |
| [The Audio Shader Language](asl.md) | Nodes, graphs, live inputs, channels, measurement taps. |
| [Kernels](kernels.md) | Block-shaped DSP and portable wasm modules. |
| [Component library](components.md) | Shipped AudioMaterials and ASL nodes. |
| [Theory](theory.md) | Notes, scales, chords, keys, audio to notes. Standalone. |
| [Spatial](spatial.md) | 3D sources, listener rotation, binaural decode. |
| [Collaboration](collab.md) | Session state, discrete edits, the shared clock, host-local devices. |
| [Hooks](hooks.md) | Named extension points for a host. |
| [Conformance](conformance.md) | How the TypeScript and Swift interpreters are kept in agreement. |

Not in this folder:

| | |
|---|---|
| [Editor](../editor/README.md) | Example AudioMaterial graph editor. Not in the npm package. |
| [Examples](../examples/README.md) | Custom-kernel plugins, the XR host adapter, and the Swift interpreter. |
