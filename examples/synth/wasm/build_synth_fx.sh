#!/usr/bin/env bash
# Compile the synth kernel (VST3 dsp copy) plus pffft to WASM.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DSP="$ROOT/../dsp"
PFFFT="${HC_PFFFT_DIR:-$HOME/Desktop/homecrate-synth-vst3/external/pffft}"
OUT="$ROOT/dist"
OBJ="$ROOT/build-fx"
CXX="${EMXX:-em++}"
CC="${EMCC:-emcc}"

if [[ ! -f "$DSP/homecrate_synthDSPKernel.cpp" ]]; then
  echo "crate-synth dsp not found at $DSP" >&2
  exit 1
fi
if [[ ! -f "$PFFFT/include/pffft/pffft.h" && ! -f "$PFFFT/pffft.h" ]]; then
  echo "pffft not found at $PFFFT (set HC_PFFFT_DIR)" >&2
  exit 1
fi
if ! command -v "$CXX" >/dev/null; then
  echo "em++ not found. Install Emscripten and ensure em++ is on PATH." >&2
  exit 1
fi

mkdir -p "$OUT" "$OBJ"

PFFFT_INC=()
if [[ -f "$PFFFT/include/pffft/pffft.h" ]]; then
  PFFFT_INC+=(-I"$PFFFT/include/pffft" -I"$PFFFT/include")
  PFFFT_C="$PFFFT/src/pffft.c"
  PFFFT_COMMON="$PFFFT/src/pffft_common.c"
else
  PFFFT_INC+=(-I"$PFFFT")
  PFFFT_C="$PFFFT/pffft.c"
  PFFFT_COMMON=""
fi

COMMON_FLAGS=(
  -O3
  -fexceptions
  -DPFFFT_SIMD_DISABLE=1
  -I"$DSP"
  "${PFFFT_INC[@]}"
)

echo "compiling pffft..."
"$CC" "${COMMON_FLAGS[@]}" -c "$PFFFT_C" -o "$OBJ/pffft.o"
if [[ -n "$PFFFT_COMMON" && -f "$PFFFT_COMMON" ]]; then
  "$CC" "${COMMON_FLAGS[@]}" -c "$PFFFT_COMMON" -o "$OBJ/pffft_common.o"
fi

echo "compiling crate-synth kernel..."
"$CXX" "${COMMON_FLAGS[@]}" -std=c++17 -c "$DSP/CostelloReverbEngine.cpp" -o "$OBJ/CostelloReverbEngine.o"
"$CXX" "${COMMON_FLAGS[@]}" -std=c++17 -c "$DSP/IRConvolver.cpp" -o "$OBJ/IRConvolver.o"
"$CXX" "${COMMON_FLAGS[@]}" -std=c++17 -c "$DSP/homecrate_synthDSPKernel.cpp" -o "$OBJ/homecrate_synthDSPKernel.o"

OBJS=(
  "$ROOT/synth_fx_bridge.cpp"
  "$OBJ/CostelloReverbEngine.o"
  "$OBJ/IRConvolver.o"
  "$OBJ/homecrate_synthDSPKernel.o"
  "$OBJ/pffft.o"
)
if [[ -f "$OBJ/pffft_common.o" ]]; then
  OBJS+=("$OBJ/pffft_common.o")
fi

echo "linking synth_fx.js / synth_fx.wasm..."
"$CXX" "${COMMON_FLAGS[@]}" -std=c++17 \
  "${OBJS[@]}" \
  --pre-js "$ROOT/synth_fx_pre.js" \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createSynthFxModule \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s STACK_SIZE=1048576 \
  -s NO_DISABLE_EXCEPTION_CATCHING=1 \
  -s EXPORTED_FUNCTIONS='["_synthfx_create","_synthfx_destroy","_synthfx_set_param","_synthfx_set_host_bpm","_synthfx_process","_synthfx_note_on","_synthfx_note_off","_synthfx_all_notes_off","_synthfx_set_ir_slot","_synthfx_clear_ir_slot","_synthfx_last_error","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPF32"]' \
  -o "$OUT/synth_fx.js"

echo "done: $OUT/synth_fx.js"
echo "note: keep $OUT/synth_fx.d.ts (hand-written types; this script does not overwrite it)"
ls -lh "$OUT/synth_fx.js" "$OUT/synth_fx.wasm"
