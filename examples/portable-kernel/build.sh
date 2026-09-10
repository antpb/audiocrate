#!/usr/bin/env bash
#
# Compile a crate portable kernel to a freestanding WebAssembly module.
#
# No emscripten. Emscripten produces a module plus a JavaScript loader that
# expects a DOM and a filesystem, and a worklet has neither. What crate loads
# is a bare module with an exported memory and no imports, which is what
# `-nostdlib --no-entry` gets you out of plain clang.
#
# Requires a clang whose target list includes wasm32 (`clang --print-targets`).
# Xcode's clang does not; a Homebrew llvm, a swiftly toolchain or the wasi-sdk
# does. Set CLANG to pick one.
set -euo pipefail
cd "$(dirname "$0")"

CLANG="${CLANG:-clang}"

"$CLANG" \
  --target=wasm32 \
  -O2 \
  -nostdlib \
  -ffreestanding \
  -Wall -Wextra \
  -Wl,--no-entry \
  -Wl,--export-memory \
  -Wl,--strip-all \
  -o tremolo.wasm \
  tremolo.c

echo "built tremolo.wasm ($(wc -c < tremolo.wasm | tr -d ' ') bytes)"
