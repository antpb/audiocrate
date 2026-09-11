#!/usr/bin/env bash
# Compile Costello + AmpDelay + IRConvolver + pffft to WASM.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DSP="$ROOT/../dsp"
PFFFT="${HC_PFFFT_DIR:-$HOME/Desktop/homecrate-amp-vst3/external/pffft}"
OUT="$ROOT/dist"
OBJ="$ROOT/build-fx"
CXX="${EMXX:-em++}"
CC="${EMCC:-emcc}"

if [[ ! -f "$DSP/IRConvolver.cpp" ]]; then
  echo "crate-amp dsp not found at $DSP" >&2
  exit 1
fi
if [[ ! -f "$PFFFT/include/pffft/pffft.h" ]]; then
  echo "pffft not found at $PFFFT (set HC_PFFFT_DIR)" >&2
  exit 1
fi
if ! command -v "$CXX" >/dev/null; then
  echo "em++ not found. Install Emscripten and ensure em++ is on PATH." >&2
  exit 1
fi

mkdir -p "$OUT" "$OBJ"

COMMON_FLAGS=(
  -O3
  -fexceptions
  -DPFFFT_SIMD_DISABLE=1
  -I"$DSP"
  -I"$PFFFT/include/pffft"
  -I"$PFFFT/include"
)

echo "compiling pffft..."
"$CC" "${COMMON_FLAGS[@]}" -c "$PFFFT/src/pffft.c" -o "$OBJ/pffft.o"
"$CC" "${COMMON_FLAGS[@]}" -c "$PFFFT/src/pffft_common.c" -o "$OBJ/pffft_common.o"

echo "compiling crate-amp FX..."
"$CXX" "${COMMON_FLAGS[@]}" -std=c++20 -c "$DSP/CostelloReverbEngine.cpp" -o "$OBJ/CostelloReverbEngine.o"
"$CXX" "${COMMON_FLAGS[@]}" -std=c++20 -c "$DSP/IRConvolver.cpp" -o "$OBJ/IRConvolver.o"

echo "linking amp_fx.js / amp_fx.wasm..."
"$CXX" "${COMMON_FLAGS[@]}" -std=c++20 \
  "$ROOT/amp_fx_bridge.cpp" \
  "$OBJ/CostelloReverbEngine.o" \
  "$OBJ/IRConvolver.o" \
  "$OBJ/pffft.o" \
  "$OBJ/pffft_common.o" \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createAmpFxModule \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s STACK_SIZE=1048576 \
  -s NO_DISABLE_EXCEPTION_CATCHING=1 \
  -s EXPORTED_FUNCTIONS='["_ampfx_create","_ampfx_destroy","_ampfx_set_param","_ampfx_set_host_bpm","_ampfx_set_ir","_ampfx_clear_ir","_ampfx_latency_samples","_ampfx_process_pre","_ampfx_process_post","_ampfx_last_error","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPF32"]' \
  -o "$OUT/amp_fx.js"

echo "done: $OUT/amp_fx.js"
echo "note: keep $OUT/amp_fx.d.ts (hand-written types; this script does not overwrite it)"
ls -lh "$OUT/amp_fx.js" "$OUT/amp_fx.wasm"
