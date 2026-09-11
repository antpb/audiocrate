#!/usr/bin/env bash
# Compile NeuralAmpModelerCore + nam_bridge.cpp to WASM.
# Uses the same NAM checkout as the iOS / VST3 builds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NAM_CORE="${HC_NAM_CORE_DIR:-$HOME/Desktop/v2nam/NeuralAmpModelerCore}"
OUT="$ROOT/dist"
OBJ="$ROOT/build"
CXX="${EMXX:-em++}"
AR="${EMAR:-emar}"

if [[ ! -f "$NAM_CORE/NAM/dsp.h" ]]; then
  echo "NAM core not found at $NAM_CORE (set HC_NAM_CORE_DIR)" >&2
  exit 1
fi
if ! command -v "$CXX" >/dev/null; then
  echo "em++ not found. Install Emscripten and ensure em++ is on PATH." >&2
  exit 1
fi

mkdir -p "$OUT" "$OBJ"

COMMON_FLAGS=(
  -O3
  -std=c++20
  -fexceptions
  -DNAM_ENABLE_A2_FAST=1
  -DEIGEN_MPL2_ONLY=1
  -I"$NAM_CORE"
  -I"$NAM_CORE/NAM"
  -I"$NAM_CORE/Dependencies/eigen"
  -I"$NAM_CORE/Dependencies/nlohmann"
)

NAM_SRCS=(
  "$NAM_CORE/NAM/activations.cpp"
  "$NAM_CORE/NAM/container.cpp"
  "$NAM_CORE/NAM/conv1d.cpp"
  "$NAM_CORE/NAM/convnet.cpp"
  "$NAM_CORE/NAM/dsp.cpp"
  "$NAM_CORE/NAM/get_dsp.cpp"
  "$NAM_CORE/NAM/lstm.cpp"
  "$NAM_CORE/NAM/ring_buffer.cpp"
  "$NAM_CORE/NAM/util.cpp"
  "$NAM_CORE/NAM/wavenet/a2_fast.cpp"
  "$NAM_CORE/NAM/wavenet/model.cpp"
  "$NAM_CORE/NAM/wavenet/slimmable.cpp"
)

echo "compiling nam_core objects..."
OBJS=()
for src in "${NAM_SRCS[@]}"; do
  name="$(basename "$(dirname "$src")")_$(basename "$src" .cpp).o"
  obj="$OBJ/$name"
  echo "  $src"
  "$CXX" "${COMMON_FLAGS[@]}" -c "$src" -o "$obj"
  OBJS+=("$obj")
done

echo "archiving libnam_core.a..."
"$AR" rcs "$OBJ/libnam_core.a" "${OBJS[@]}"

echo "linking nam.js / nam.wasm..."
"$CXX" "${COMMON_FLAGS[@]}" \
  "$ROOT/nam_bridge.cpp" \
  -Wl,--whole-archive "$OBJ/libnam_core.a" -Wl,--no-whole-archive \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createNamModule \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s STACK_SIZE=2097152 \
  -s NO_DISABLE_EXCEPTION_CATCHING=1 \
  -s EXPORTED_FUNCTIONS='["_nam_create","_nam_destroy","_nam_process","_nam_last_error","_nam_has_loudness","_nam_get_loudness","_nam_has_input_level","_nam_get_input_level","_nam_architecture","_nam_is_a2_fast","_nam_a2_channels","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPF32"]' \
  -o "$OUT/nam.js"

echo "done: $OUT/nam.js"
echo "note: keep $OUT/nam.d.ts (hand-written types; this script does not overwrite it)"
ls -lh "$OUT"