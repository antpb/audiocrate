#!/usr/bin/env bash
# hc_dynEQ's kernel (dsp/dyneq_kernel.cpp) to WASM: wasm/dist/dyneq.{js,wasm}.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/dist"
CXX="${EMXX:-em++}"
command -v "$CXX" >/dev/null || { echo "em++ not found. Install Emscripten." >&2; exit 1; }
mkdir -p "$OUT"
"$CXX" -std=c++17 -O3 "$ROOT/../dsp/dyneq_kernel.cpp" "$ROOT/dyneq_bridge.cpp" \
  --pre-js "$ROOT/../../synth/wasm/synth_fx_pre.js" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createDyneqModule \
  -s ENVIRONMENT=web,worker,node -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=16777216 \
  -s EXPORTED_FUNCTIONS='["_dyneq_create","_dyneq_destroy","_dyneq_set_param","_dyneq_buffer","_dyneq_process","_dyneq_follower","_dyneq_gain_reduction"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32"]' \
  -o "$OUT/dyneq.js"
ls -lh "$OUT/dyneq.js" "$OUT/dyneq.wasm"
