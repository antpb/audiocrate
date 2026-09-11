# Space Reverb

The Costello FDN the amp already ships, as its own AudioMaterial. Core
crate does not import this package.

```ts
import { registerAudioMaterial } from 'audiocrate';
import { spaceReverbPlugin } from './src/index';

registerAudioMaterial(spaceReverbPlugin);
```

Live playback also needs the kernel in the worklet bundle. The editor does
that through `examples/homecrate`.

## Signal path

```
in -> Costello (pre-delay, diffusion, 8-line modulated FDN) -> [gate] -> out
```

Wet/dry is `reverbBlend` inside the engine, same mapping the amp uses.
`reverbGate` keys an envelope-follower VCA on the dry input and scales
the wet contribution.

## Layout

```
dsp/       Costello copy (from examples/amp)
wasm/      emscripten bridge
wasm/dist  space_reverb.{js,wasm}
src/       AudioMaterial, plugin, kernel factory
```

`dsp/CostelloReverbEngine.*` is a copy of the amp files. Edit the amp
copy and recopy.

```bash
bash wasm/build_space_reverb.sh
```

Copy provenance is in `SOURCE.txt`.
