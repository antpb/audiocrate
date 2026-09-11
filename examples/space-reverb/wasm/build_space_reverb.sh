#!/usr/bin/env bash
# Compile Costello to WASM.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DSP="$ROOT/../dsp"
OUT="$ROOT/dist"
OBJ="$ROOT/build-fx"
CXX="${EMXX:-em++}"

if [[ ! -f "$DSP/CostelloReverbEngine.cpp" ]]; then
  echo "crate-space-reverb dsp not found at $DSP" >&2
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
)

echo "compiling crate-space-reverb..."
"$CXX" "${COMMON_FLAGS[@]}" -std=c++20 -c "$DSP/CostelloReverbEngine.cpp" -o "$OBJ/CostelloReverbEngine.o"

echo "linking space_reverb.js / space_reverb.wasm..."
"$CXX" "${COMMON_FLAGS[@]}" -std=c++20 \
  "$ROOT/space_reverb_bridge.cpp" \
  "$OBJ/CostelloReverbEngine.o" \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createSpaceReverbModule \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216 \
  -s STACK_SIZE=1048576 \
  -s NO_DISABLE_EXCEPTION_CATCHING=1 \
  -s EXPORTED_FUNCTIONS='["_spacereverb_create","_spacereverb_destroy","_spacereverb_set_param","_spacereverb_process","_spacereverb_last_error","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPF32"]' \
  -o "$OUT/space_reverb.js"

echo "done: $OUT/space_reverb.js"
echo "note: keep $OUT/space_reverb.d.ts (hand-written types; this script does not overwrite it)"
ls -lh "$OUT/space_reverb.js" "$OUT/space_reverb.wasm"
