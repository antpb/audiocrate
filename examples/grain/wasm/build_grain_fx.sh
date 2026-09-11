#!/usr/bin/env bash
# Compile the grain kernel (VST3 dsp copy) to WASM.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DSP="$ROOT/../dsp"
OUT="$ROOT/dist"
OBJ="$ROOT/build-fx"
CXX="${EMXX:-em++}"

if [[ ! -f "$DSP/homecrate_grainDSPKernel.cpp" ]]; then
  echo "crate-grain dsp not found at $DSP" >&2
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
  -I"$DSP"
  -I"$ROOT/../params"
)

echo "compiling crate-grain kernel..."
"$CXX" "${COMMON_FLAGS[@]}" -std=c++17 -c "$DSP/CostelloReverbEngine.cpp" -o "$OBJ/CostelloReverbEngine.o"
"$CXX" "${COMMON_FLAGS[@]}" -std=c++17 -c "$DSP/homecrate_grainDSPKernel.cpp" -o "$OBJ/homecrate_grainDSPKernel.o"

echo "linking grain_fx.js / grain_fx.wasm..."
"$CXX" "${COMMON_FLAGS[@]}" -std=c++17 \
  "$ROOT/grain_fx_bridge.cpp" \
  "$OBJ/CostelloReverbEngine.o" \
  "$OBJ/homecrate_grainDSPKernel.o" \
  --pre-js "$ROOT/grain_fx_pre.js" \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createGrainFxModule \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s STACK_SIZE=1048576 \
  -s NO_DISABLE_EXCEPTION_CATCHING=1 \
  -s EXPORTED_FUNCTIONS='["_grainfx_create","_grainfx_destroy","_grainfx_set_param","_grainfx_set_host_bpm","_grainfx_process","_grainfx_load_loop","_grainfx_release_loop","_grainfx_note_on","_grainfx_note_off","_grainfx_cc","_grainfx_last_error","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPF32"]' \
  -o "$OUT/grain_fx.js"

echo "done: $OUT/grain_fx.js"
echo "note: keep $OUT/grain_fx.d.ts (hand-written types; this script does not overwrite it)"
ls -lh "$OUT/grain_fx.js" "$OUT/grain_fx.wasm"
