# CrateC on hardware

The third audiocrate interpreter, compiled for and running on a real device:
the Sonicake Pocket Master's BP1048 (Andes NDS32, single-precision FPU).

This directory is the bridge between the portable interpreter in `../src`
and a firmware. It holds no device-specific code of its own beyond a static
arena and an int16 block converter, so the same files prove out on the
desktop and compile for the chip unchanged.

## What is proven

- **Compiles for the target.** `src/crate.c`, `src/crate_pool.c` and
  `crate_firmware.c` build with `nds32le-elf-gcc -mcpu=d1088-spu`: 33 KB of
  code, hardware single-precision float throughout (586 FP instructions in
  the interpreter, zero software-double calls on the signal path).
- **Bit-identical to the reference, in the chip's types.** `make
  firmware-selftest` builds `crate_fw_process` with `CRATE_REAL_FLOAT` and
  `CRATE_LINE_INT16` (what the chip uses) and renders a test signal through
  it, then compares against a direct `crate_render` of the same embedded
  plan fed the same int16-quantised input: worst difference 0 int16 steps,
  finite, in range, deterministic across runs. The conformance gate already
  ties `crate_render` to the JavaScript and Swift references, so the wrapper
  that runs on hardware is proven not to change the sound.
- **Fits.** The `fuzz` insert embeds as a 1.5 KB plan and needs 1.5 KB of
  arena; the whole firmware is 33 KB code + 15 KB RAM with an 8 KB arena.
  Trivially inside a free flash gap and the BP1048's 288 KB SRAM.

## Build

```bash
# desktop proof (host compiler), run before trusting the chip build
make firmware-selftest EMBED_PATCH=fuzz

# the object files for the chip
PATH=../../../../../contribution/pocket-master-crate/tools/binutils/nds32/bin:/usr/bin:$PATH
nds32le-elf-gcc -std=c99 -Os -mcpu=d1088-spu -mext-dsp \
  -fsingle-precision-constant -ffunction-sections -fdata-sections \
  -DCRATE_REAL_FLOAT -DCRATE_LINE_INT16 -DCRATE_FW_ARENA_BYTES=8192 \
  -Iinclude -Ifirmware -c src/crate.c src/crate_pool.c firmware/crate_firmware.c
```

`EMBED_PATCH` picks which factory patch is compiled in (`crate_embed.h` is
generated from `build/factory-compiled.json`). Any insert or instrument id
from `cratesim --list` works.

## The firmware contract

A firmware calls three functions (`crate_firmware.h`):

- `crate_fw_init(sample_rate)` once before audio starts.
- `crate_fw_process(int16 *interleaved, frames)` in the audio frame: it
  replaces the block with the engine's output. For an insert the left
  channel is the input (the guitar).
- `crate_fw_midi(bytes, count)` with raw MIDI: CC n moves the parameter
  whose address is n; notes play an instrument patch.

## The remaining step: into the Pocket Master's audio frame

The host side is a short shim in a rebuilt SDK application (kept in the
private `pocket-master-crate` tree, not here, because it links MVSilicon
SDK code). The stock firmware's per-frame audio routine is at application
address `0x5787c`; its DAC output is AudioCore sink 0, 16-bit interleaved
stereo at 44100, 256-frame blocks. The shim runs the stock chain, then
calls `crate_fw_process` on the sink block. With a stock preset bypassed,
crate becomes the whole effect, guitar in to processed out. That is the
audible proof, and it is a wiring task on top of a core that is already
correct.
