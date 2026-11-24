/*
 * The device engine: one pack, one loaded patch, audio in, MIDI in, audio
 * out. This is the whole surface a firmware calls, and the only thing in
 * CrateC that knows a patch is one of a list.
 *
 * Threading. A device has an audio task and, separately, whoever receives
 * MIDI (a USB endpoint, a BLE characteristic) and whoever draws the screen.
 * None of those touch render state. MIDI bytes go into a ring per source,
 * a patch change is a request, and both are applied at the top of the next
 * `crate_engine_process`, on the audio task. One producer per source and one
 * consumer, so the rings need no lock on a single-core target.
 *
 * MIDI. Plain MIDI bytes, any framing: running status, interleaved realtime
 * bytes and SysEx are handled. BLE MIDI's packet header and timestamp bytes
 * are a transport concern and are stripped by the BLE glue before they get
 * here. The mapping is the iOS crate AU's: notes play the pool, CC n glides
 * the parameter whose address is n across its range, CC 120 and 123 release
 * every voice.
 */
#ifndef CRATE_ENGINE_H
#define CRATE_ENGINE_H

#include "crate.h"
#include "crate_pack.h"
#include "crate_pool.h"

#ifdef __cplusplus
extern "C" {
#endif

enum crate_midi_source { CRATE_MIDI_USB = 0, CRATE_MIDI_BLE = 1, CRATE_MIDI_DIN = 2, CRATE_MIDI_SOURCES = 3 };

#define CRATE_MIDI_RING 256 /* bytes per source, a power of two */

typedef struct crate_midi_ring {
    uint8_t data[CRATE_MIDI_RING];
    volatile uint16_t head; /* written by the producer */
    volatile uint16_t tail; /* written by the audio task */
} crate_midi_ring;

typedef struct crate_midi_parser {
    uint8_t status;   /* running status, 0 for none */
    uint8_t data[2];
    uint8_t count;
    uint8_t in_sysex;
} crate_midi_parser;

typedef struct crate_engine_config {
    double sample_rate;
    int max_frames;          /* the largest block `process` will be handed */
    int max_voices;          /* an instrument's polyphony is clamped to this */
    double bpm;              /* the internal transport's tempo */
    /* Mix the dry input under an instrument. An instrument graph has no
     * audio input, so without this a guitar plugged into a synth patch is
     * not heard at all. */
    int dry_under_instruments;
    /* The input is one channel (a guitar jack), and `process` is always
     * handed in_r == NULL. A stereo insert that would only mirror its left
     * channel then never renders its right, so its right-channel lines are
     * not reserved: half the memory of every mirrorable delay. */
    int mono_input;
    /* The last stage before the converter. Below `safety_threshold` it is
     * the identity, so a patch that never gets there sounds exactly as it
     * does on iOS. Above it a soft knee folds the peak toward full scale
     * instead of letting the converter square it off, and a non-finite
     * sample becomes silence rather than a full-scale burst into somebody's
     * headphones. On by default; a factory instrument playing a four note
     * chord on four voices goes past full scale without it. */
    int output_safety;
    float safety_threshold;
} crate_engine_config;

void crate_engine_default_config(crate_engine_config *config);

typedef struct crate_engine {
    crate_engine_config config;
    const uint8_t *pack;
    const crate_pack_header *h;
    const crate_pack_entry *entries;
    uint8_t *arena_memory;
    size_t arena_bytes;
    crate_arena arena;

    int current;           /* loaded entry, -1 for none */
    volatile int requested; /* entry asked for by another task, -1 for none */
    int load_error;        /* why the last load failed, 0 for none */
    int role;
    crate_plan plan;
    crate_state state;     /* an insert */
    crate_pool pool;       /* an instrument */
    int16_t cc_voice[128]; /* address -> voice plan param index, -1 */
    int16_t cc_bus[128];   /* address -> bus plan param index, -1 */
    int16_t cc_entry[128]; /* address -> pack param, -1 */

    crate_midi_ring rings[CRATE_MIDI_SOURCES];
    crate_midi_parser parsers[CRATE_MIDI_SOURCES];

    crate_transport transport;
    uint32_t seed;
    float *scratch_r;
} crate_engine;

enum crate_engine_error {
    CRATE_ENGINE_OK = 0,
    CRATE_ENGINE_BAD_PACK = -1,
    CRATE_ENGINE_NO_SUCH_PATCH = -2,
    CRATE_ENGINE_UNAVAILABLE = -3, /* the pack says it does not fit */
    CRATE_ENGINE_OUT_OF_MEMORY = -4,
    CRATE_ENGINE_BAD_PLAN = -5
};

/* `arena` holds the loaded patch; the engine never allocates anything else.
 * Returns CRATE_ENGINE_OK or CRATE_ENGINE_BAD_PACK. */
int crate_engine_init(crate_engine *engine, const crate_engine_config *config,
                      const void *pack, size_t pack_size, void *arena, size_t arena_bytes);

/* The list, for a screen. Any task. */
int crate_engine_count(const crate_engine *engine);
const char *crate_engine_name(const crate_engine *engine, int index);
const char *crate_engine_id(const crate_engine *engine, int index);
const char *crate_engine_category(const crate_engine *engine, int index);
int crate_engine_role(const crate_engine *engine, int index);
int crate_engine_slot(const crate_engine *engine, int index);
int crate_engine_available(const crate_engine *engine, int index);
int crate_engine_category_count(const crate_engine *engine);
const char *crate_engine_category_at(const crate_engine *engine, int index);

/* Asks for a patch; it is loaded at the top of the next block, which renders
 * silence. Any task. */
void crate_engine_request(crate_engine *engine, int index);
/* Loads now. The audio task only, or before audio starts. */
int crate_engine_load(crate_engine *engine, int index);

/* Queues MIDI bytes from one source. That source's task only. Bytes that do
 * not fit are dropped, oldest first kept. Returns how many were queued. */
int crate_engine_midi(crate_engine *engine, int source, const uint8_t *bytes, int count);
/* One BLE MIDI characteristic value (a notification from a keyboard, or a
 * write from a phone), decoded and queued under CRATE_MIDI_BLE. The BLE
 * task only. Returns the bytes queued, or -1 for a packet with no header. */
int crate_engine_ble_midi(crate_engine *engine, const uint8_t *packet, int length);

/* One block. The audio task. `in_r` may be NULL for a mono input; `out_r`
 * may be NULL for a mono output. Frames past `max_frames` are rendered in
 * chunks. */
void crate_engine_process(crate_engine *engine, const float *in_l, const float *in_r,
                          float *out_l, float *out_r, int frames);

void crate_engine_set_bpm(crate_engine *engine, double bpm);

/* Settings a screen or a MIDI command may change while audio runs. Plain
 * stores the audio task reads once per block. Any task. */
void crate_engine_set_dry_under_instruments(crate_engine *engine, int on);
void crate_engine_set_output_safety(crate_engine *engine, int on);

#ifdef __cplusplus
}
#endif

#endif
