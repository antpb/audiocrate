#!/usr/bin/env bash
# The drum's VST3 engine (vst3/, DrumEngine + kernel) plus pffft to WASM:
# wasm/dist/drum_fx.{js,wasm}. pffft comes from the VST3 project's external/
# (set HC_PFFFT_DIR to use another copy), as the synth's build does.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/../vst3"
PFFFT="${HC_PFFFT_DIR:-$HOME/Desktop/homecrate-drum-vst3/external/pffft}"
OUT="$ROOT/dist"
OBJ="$ROOT/build-fx"
CC="${EMCC:-emcc}"
CXX="${EMXX:-em++}"
command -v "$CXX" >/dev/null || { echo "em++ not found. Install Emscripten." >&2; exit 1; }
[[ -f "$PFFFT/src/pffft.c" ]] || { echo "pffft not found at $PFFFT (set HC_PFFFT_DIR)" >&2; exit 1; }
mkdir -p "$OUT" "$OBJ"
FLAGS=(-O3 -DPFFFT_SIMD_DISABLE=1 -I"$PFFFT/include/pffft" -I"$PFFFT/include" -I"$PFFFT/src" -I"$SRC/dsp")
"$CC" "${FLAGS[@]}" -c "$PFFFT/src/pffft.c" -o "$OBJ/pffft.o"
[[ -f "$PFFFT/src/pffft_common.c" ]] && "$CC" "${FLAGS[@]}" -c "$PFFFT/src/pffft_common.c" -o "$OBJ/pffft_common.o"
"$CXX" "${FLAGS[@]}" -std=c++17 \
  "$SRC/dsp/homecrate_drumDSPKernel.cpp" "$SRC/dsp/IRConvolver.cpp" "$ROOT/drum_fx_bridge.cpp" "$OBJ"/pffft*.o \
  --pre-js "$ROOT/../../synth/wasm/synth_fx_pre.js" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createDrumFxModule \
  -s ENVIRONMENT=web,worker,node -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=67108864 -s STACK_SIZE=1048576 \
  -s EXPORTED_FUNCTIONS='["_drumfx_create","_drumfx_destroy","_drumfx_set_param","_drumfx_load_pad","_drumfx_note_on","_drumfx_set_context","_drumfx_buffer","_drumfx_process","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32"]' \
  -o "$OUT/drum_fx.js"
ls -lh "$OUT/drum_fx.js" "$OUT/drum_fx.wasm"
