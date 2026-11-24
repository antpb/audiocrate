/*
 * A pack: a library of compiled patches in one blob, the thing a device
 * keeps in flash. `cratepack` writes it from the factory library.
 *
 * Like a plan, every reference is an offset from the start of the pack, so
 * it can be executed in place. Each entry carries what a device needs to
 * list, load and play a patch without anything else: its name and category,
 * whether it is an insert or an instrument, the parameters a CC can address,
 * and the arena footprint measured when the pack was built, which is how a
 * device knows before loading whether a patch fits.
 */
#ifndef CRATE_PACK_H
#define CRATE_PACK_H

#include <stdint.h>

#define CRATE_PACK_MAGIC 0x4B505243u /* "CRPK" little endian */
#define CRATE_PACK_VERSION 1

enum crate_pack_role { CRATE_ROLE_INSERT = 0, CRATE_ROLE_INSTRUMENT = 1 };

/* The factory library's own filing: an effect, an instrument, or a patch
 * that plays itself and also takes an input. */
enum crate_pack_slot { CRATE_SLOT_EFFECT = 0, CRATE_SLOT_INSTRUMENT = 1, CRATE_SLOT_EITHER = 2 };

enum crate_pack_entry_flags {
    /* Fits the budget the pack was built for. */
    CRATE_PACK_AVAILABLE = 1,
    /* At least one delay line was sized down to what its controls reach. */
    CRATE_PACK_LINES_FITTED = 2
};

typedef struct crate_pack_header {
    uint32_t magic;
    uint16_t version;
    uint16_t count;
    uint32_t size;
    uint32_t entries_off;
    uint32_t strings_off;
    uint32_t sample_rate;   /* the rate footprints were measured at */
    uint32_t budget_bytes;  /* the arena a patch had to fit to be available */
    uint16_t bpm_min;       /* the tempo range delay lines were sized for */
    uint16_t bpm_max;
    uint16_t category_count;
    uint16_t flags;         /* crate_pack_header_flags */
    uint32_t categories_off; /* uint32 string offsets, display order */
} crate_pack_header;

enum crate_pack_header_flags {
    /* Footprints were measured for a one-channel input (`mono_input` in
     * crate_engine_config). A stereo device needs a pack measured stereo. */
    CRATE_PACK_MEASURED_MONO = 1
};

typedef struct crate_pack_param {
    uint32_t name_off;    /* the param a graph reads, e.g. "lp_cutoff" */
    uint32_t label_off;   /* what a screen shows, e.g. "Cutoff" */
    float min;
    float max;
    float def;
    uint16_t address;     /* the CC number that moves it */
    uint16_t pad;
} crate_pack_param;

typedef struct crate_pack_entry {
    uint32_t plan_off;
    uint32_t plan_size;
    uint32_t id_off;
    uint32_t name_off;
    uint32_t category_off;
    uint32_t params_off;  /* crate_pack_param[param_count] */
    uint16_t param_count;
    uint8_t role;
    uint8_t flags;
    uint16_t polyphony;
    uint8_t slot;         /* crate_pack_slot: where the library files it */
    uint8_t pad;
    uint32_t arena_bytes; /* measured footprint at `sample_rate` */
} crate_pack_entry;

#endif
