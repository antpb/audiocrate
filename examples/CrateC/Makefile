# CrateC host build. A device build compiles src/ alone with its own
# toolchain; nothing under host/ or test/ is ever linked into firmware.
#
#   make conformance         double, the gate (tolerance 5e-6)
#   make conformance-float   float, the measurement for a single-precision FPU
#   make pack                the factory library as build/factory.pack
#   make smoke               every patch in the pack, loaded and played
#   make ble-midi            BLE MIDI packet decoding

CC ?= cc
CFLAGS ?= -std=c99 -O2 -Wall -Wextra -Wno-unused-parameter -Wshadow
INCLUDES = -Iinclude -Ihost
BUILD = build

# What a device compiles. Its types are the device's: float evaluation and
# int16 audio lines. The pack tool and the simulator are built the same way,
# so a footprint measured here is the footprint a device sees.
DEVICE_DEFS = -DCRATE_REAL_FLOAT -DCRATE_LINE_INT16

RUNTIME = src/crate.c src/crate_pool.c src/crate_engine.c src/crate_ble_midi.c
HOST = host/json.c host/crate_build.c
HEADERS = include/crate.h include/crate_pool.h include/crate_pack.h include/crate_engine.h include/crate_ble_midi.h
FIXTURE = ../../fixtures/asl-conformance.json
FLOAT_TOLERANCE ?= 1e-3

PACK_RATE ?= 44100
PACK_BUDGET ?= 131072
PACK_VOICES ?= 4
# The Pocket Master's effect input is one guitar jack.
PACK_INPUT ?= --mono-input

EMBED_PATCH ?= fuzz

all: $(BUILD)/conformance $(BUILD)/conformance-float $(BUILD)/cratepack $(BUILD)/cratesim $(BUILD)/ble-midi $(BUILD)/crate_embed

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/conformance: $(RUNTIME) $(HOST) test/conformance.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(INCLUDES) $(RUNTIME) $(HOST) test/conformance.c -lm -o $@

$(BUILD)/conformance-float: $(RUNTIME) $(HOST) test/conformance.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) -DCRATE_REAL_FLOAT $(INCLUDES) $(RUNTIME) $(HOST) test/conformance.c -lm -o $@

$(BUILD)/cratepack: $(RUNTIME) $(HOST) host/cratepack.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(DEVICE_DEFS) $(INCLUDES) $(RUNTIME) $(HOST) host/cratepack.c -lm -o $@

$(BUILD)/cratesim: $(RUNTIME) host/json.c host/cratesim.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(DEVICE_DEFS) $(INCLUDES) $(RUNTIME) host/json.c host/cratesim.c -lm -o $@

$(BUILD)/ble-midi: src/crate_ble_midi.c test/ble_midi.c include/crate_ble_midi.h | $(BUILD)
	$(CC) $(CFLAGS) $(INCLUDES) src/crate_ble_midi.c test/ble_midi.c -o $@

ble-midi: $(BUILD)/ble-midi
	./$(BUILD)/ble-midi

conformance: $(BUILD)/conformance
	./$(BUILD)/conformance $(FIXTURE)

conformance-float: $(BUILD)/conformance-float
	./$(BUILD)/conformance-float $(FIXTURE) --tolerance $(FLOAT_TOLERANCE)

$(BUILD)/factory-compiled.json: tools/emit-factory-compiled.ts tools/emit-factory-compiled.mjs | $(BUILD)
	node tools/emit-factory-compiled.mjs $@

pack: $(BUILD)/cratepack $(BUILD)/factory-compiled.json
	./$(BUILD)/cratepack $(BUILD)/factory-compiled.json $(BUILD)/factory.pack \
		--rate $(PACK_RATE) --budget $(PACK_BUDGET) --voices $(PACK_VOICES) $(PACK_INPUT) --report

smoke: pack $(BUILD)/cratesim
	./$(BUILD)/cratesim $(BUILD)/factory.pack --smoke

$(BUILD)/crate_embed: $(HOST) src/crate.c host/crate_embed.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(INCLUDES) $(HOST) src/crate.c host/crate_embed.c -lm -o $@

# One embedded patch (EMBED_PATCH) as a C header the firmware links in.
firmware/crate_embed.h: $(BUILD)/crate_embed $(BUILD)/factory-compiled.json
	./$(BUILD)/crate_embed $(BUILD)/factory-compiled.json $(EMBED_PATCH) firmware/crate_embed.h

# The firmware host built for the desktop, so the embedded path is proven
# byte-for-byte against the reference before any chip is involved.
$(BUILD)/firmware-selftest: firmware/crate_embed.h firmware/crate_firmware.c firmware/selftest.c $(RUNTIME) $(HEADERS) firmware/crate_firmware.h | $(BUILD)
	$(CC) $(CFLAGS) $(DEVICE_DEFS) $(INCLUDES) -Ifirmware src/crate.c src/crate_pool.c firmware/crate_firmware.c firmware/selftest.c -lm -o $@

firmware-selftest: $(BUILD)/firmware-selftest
	./$(BUILD)/firmware-selftest

clean:
	rm -rf $(BUILD)

.PHONY: all conformance conformance-float ble-midi pack smoke clean
