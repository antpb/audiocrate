#!/usr/bin/env bash
# CrateC as a WASM kernel for the browser (web/crate_web.c).
#
#   examples/CrateC/web/build.sh   ->  web/dist/crate_web.js + crate_web.wasm
#
# Double evaluation, float delay lines: the conformance build's types, so
# the web plays what the reference plays (no device int16 lines here).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/web/dist"
CC="${EMCC:-emcc}"
command -v "$CC" >/dev/null || { echo "emcc not found. Install Emscripten." >&2; exit 1; }
mkdir -p "$OUT"
"$CC" -std=c99 -D_POSIX_C_SOURCE=200809L -O3 -Wall -Wno-unused-parameter \
  -I"$ROOT/include" -I"$ROOT/host" \
  "$ROOT/src/crate.c" "$ROOT/src/crate_pool.c" "$ROOT/host/json.c" "$ROOT/host/crate_build.c" "$ROOT/web/crate_web.c" \
  --pre-js "$ROOT/web/pre.js" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createCrateWebModule \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=33554432 -s STACK_SIZE=1048576 \
  -s EXPORTED_FUNCTIONS='["_crateweb_create","_crateweb_set_tables","_crateweb_destroy","_crateweb_last_error","_crateweb_param_count","_crateweb_param_name","_crateweb_set_param","_crateweb_note_on","_crateweb_note_off","_crateweb_all_notes_off","_crateweb_active_voices","_crateweb_set_transport","_crateweb_buffer","_crateweb_process","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPF32","HEAPU8","HEAPU32"]' \
  -o "$OUT/crate_web.js"
ls -lh "$OUT/crate_web.js" "$OUT/crate_web.wasm"
