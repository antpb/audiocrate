# Amp

Neural amp AudioMaterial: NAM inference plus Costello, delay, and IR in
`amp_fx.wasm`. Core crate does not import this package.

```ts
import { registerAudioMaterial } from 'audiocrate';
import { ampPlugin } from './src/index';

registerAudioMaterial(ampPlugin);
```

Live playback also needs the kernel in the worklet bundle. The editor does
that through `examples/homecrate`.

## Signal path

```
in -> pad -> input gain -> [EQ if pre] -> [reverb if pre] -> NAM
   -> IR -> [EQ if post] -> [reverb if post] -> delay @ seam -> out gain
```

Delay seams A-D are resolved from `delayPlacement` against `reverbPreAmp`.
Morph A/B reuses the second NAM/IR slot and is mutually exclusive with
`stereoMode`. See `dsp/homecrate_ampDSPKernel.h`.

`ampMaterial` is the param schema and analog ASL around the seam. NAM
binds through `neural.nam`. Costello, delay, and IR bind at that seam
from `wasm/dist/amp_fx.{js,wasm}`.

## Layout

```
dsp/           kernel, IR, Costello, delay (copied from the VST3 tree)
params/        params_gen.h
wasm/          emscripten bridges
wasm/dist      nam.{js,wasm}, amp_fx.{js,wasm}
wasm/fixtures  lstm.nam, red_face_75_4vol_a2full.nam
src/           AudioMaterial, plugin, kernel factory
```

## Rebuild

From this package:

```bash
bash wasm/build.sh
bash wasm/build_amp_fx.sh
```

NAM uses `HC_NAM_CORE_DIR` (default `~/Desktop/v2nam/NeuralAmpModelerCore`),
`NAM_ENABLE_A2_FAST=1`, and `--whole-archive` so architecture parsers
self-register. FX uses `HC_PFFFT_DIR` (default
`~/Desktop/homecrate-amp-vst3/external/pffft`) with `PFFFT_SIMD_DISABLE`.

The WASM build points at the same NAM checkout the VST3 CMake uses. Do not
fork NeuralAmpModelerCore for this package. Static initializers in
`wavenet/model.cpp` have to survive linking or every `.nam` load fails
with "No config parser registered".

Not in this tree: NAM core, Eigen, nlohmann, pffft, VST3 SDK, AUv3 host,
and the extra factory A2 profiles (`soy_milk_*`, a2slim).

Copy provenance is in `SOURCE.txt`.
