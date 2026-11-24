#include "crate_firmware.h"

#include "crate.h"
#include "crate_pool.h"
#include "crate_engine.h" /* for the crate_engine_error codes */
#include "crate_embed.h"

#include <stddef.h>

/*
 * Every mutable byte the engine uses is in one context taken from the host's
 * allocator at init, so an injected build carries no static RAM window of its
 * own: a single pointer is all that lives in .bss, and it can sit in a few
 * bytes the host shim owns. The arena that follows holds node memory and
 * delay lines (CRATE_FW_ARENA_BYTES); the big allocation a patch needs comes
 * from the host heap, which knows what is free.
 */
#ifndef CRATE_FW_ARENA_BYTES
#define CRATE_FW_ARENA_BYTES (16 * 1024)
#endif
#ifndef CRATE_FW_MAX_FRAMES
#define CRATE_FW_MAX_FRAMES 256
#endif

typedef struct crate_fw_ctx {
    crate_arena arena;
    crate_plan plan;
    int instrument;
    double rate;
    int16_t cc[128];        /* address -> engine param index */
    float in[CRATE_FW_MAX_FRAMES];
    float out_l[CRATE_FW_MAX_FRAMES];
    float out_r[CRATE_FW_MAX_FRAMES];
    uint8_t midi_status, midi_data[2], midi_n;
    /* Last, and only the member the patch's role uses is allocated: an
     * insert's state is 160 bytes on the BP1048, an instrument's pool 3.5 KB.
     * The arena follows it in the same block. */
    union { crate_state state; crate_pool pool; } role;
} crate_fw_ctx;

#define ROLE_BYTES(instrument) \
    ((offsetof(crate_fw_ctx, role) + ((instrument) ? sizeof(crate_pool) : sizeof(crate_state)) + 7u) & ~(size_t)7u)

static crate_fw_ctx *g_ctx;

int crate_fw_init(double sample_rate, crate_fw_alloc alloc) {
    g_ctx = 0;
    if (!alloc) return CRATE_ENGINE_OUT_OF_MEMORY;
    /* Host heaps may hand back 4-byte aligned blocks (FreeRTOS heap_5 on the
     * BP1048 does), but the context holds doubles and the compiler moves them
     * with 64-bit FPU loads/stores that fault when misaligned. Over-allocate
     * and align the context up to 8; the arena inside inherits it. */
    uint8_t *raw = (uint8_t *)alloc(crate_fw_footprint());
    if (!raw) return CRATE_ENGINE_OUT_OF_MEMORY;
    crate_fw_ctx *c = (crate_fw_ctx *)(raw + ((8u - ((uintptr_t)raw & 7u)) & 7u));
    for (int i = 0; i < 128; i++) c->cc[i] = -1;
    c->rate = sample_rate;
    c->instrument = CRATE_EMBED_ROLE_INSTRUMENT;
    c->midi_status = 0;
    c->midi_n = 0;

    if (crate_plan_open(&c->plan, crate_embed_plan, sizeof crate_embed_plan) != 0) return CRATE_ENGINE_BAD_PLAN;
    crate_arena_init(&c->arena, (uint8_t *)c + ROLE_BYTES(CRATE_EMBED_ROLE_INSTRUMENT), CRATE_FW_ARENA_BYTES);

    if (CRATE_EMBED_ROLE_INSTRUMENT) {
        if (crate_pool_init(&c->role.pool, &c->plan, &c->arena, 4, 1, CRATE_FW_MAX_FRAMES) != 0) return CRATE_ENGINE_OUT_OF_MEMORY;
        if (crate_pool_prepare(&c->role.pool, sample_rate) != 0) return CRATE_ENGINE_OUT_OF_MEMORY;
        for (int i = 0; i < CRATE_EMBED_PARAM_COUNT; i++)
            crate_pool_set_param(&c->role.pool, crate_embed_params[i].name, crate_embed_params[i].def);
    } else {
        if (crate_state_init(&c->role.state, &c->plan, &c->arena, 1) != 0) return CRATE_ENGINE_OUT_OF_MEMORY;
        if (crate_state_prepare(&c->role.state, sample_rate) != 0) return CRATE_ENGINE_OUT_OF_MEMORY;
        for (int i = 0; i < CRATE_EMBED_PARAM_COUNT; i++)
            crate_set_param(&c->role.state, crate_embed_params[i].name, crate_embed_params[i].def);
        c->role.state.gate = 1; /* an insert's envelope runs */
    }

    for (int i = 0; i < CRATE_EMBED_PARAM_COUNT; i++) {
        int a = crate_embed_params[i].address;
        if (a >= 0 && a < 128) c->cc[a] = (int16_t)crate_plan_param_index(&c->plan, crate_embed_params[i].name);
    }
    g_ctx = c;
    return CRATE_ENGINE_OK;
}

int crate_fw_ready(void) { return g_ctx != 0; }

unsigned long crate_fw_footprint(void) { return ROLE_BYTES(CRATE_EMBED_ROLE_INSTRUMENT) + CRATE_FW_ARENA_BYTES + 7u; }
unsigned long crate_fw_arena_used(void) { return g_ctx ? (unsigned long)g_ctx->arena.used : 0; }

static void apply_cc(crate_fw_ctx *c, uint8_t d1, uint8_t d2) {
    if (d1 >= 128 || c->cc[d1] < 0) return;
    for (int i = 0; i < CRATE_EMBED_PARAM_COUNT; i++) {
        if (crate_embed_params[i].address != d1) continue;
        double t = (double)d2 / 127.0;
        double v = crate_embed_params[i].min + t * (crate_embed_params[i].max - crate_embed_params[i].min);
        if (CRATE_EMBED_ROLE_INSTRUMENT) crate_pool_glide_param(&c->role.pool, crate_embed_params[i].name, v);
        else crate_glide_param(&c->role.state, crate_embed_params[i].name, v);
        return;
    }
}

void crate_fw_midi(const uint8_t *bytes, int count) {
    crate_fw_ctx *c = g_ctx;
    if (!c) return;
    for (int i = 0; i < count; i++) {
        uint8_t b = bytes[i];
        if (b & 0x80) {
            if (b >= 0xF8) continue;        /* realtime */
            c->midi_status = b < 0xF0 ? b : 0;
            c->midi_n = 0;
            continue;
        }
        if (!c->midi_status) continue;
        c->midi_data[c->midi_n++] = b;
        uint8_t kind = c->midi_status & 0xF0;
        int need = (kind == 0xC0 || kind == 0xD0) ? 1 : 2;
        if (c->midi_n < need) continue;
        uint8_t d1 = c->midi_data[0], d2 = need > 1 ? c->midi_data[1] : 0;
        c->midi_n = 0;
        if (CRATE_EMBED_ROLE_INSTRUMENT && kind == 0x90 && d2 > 0) crate_pool_note_on(&c->role.pool, d1, (double)d2 / 127.0);
        else if (CRATE_EMBED_ROLE_INSTRUMENT && (kind == 0x80 || (kind == 0x90 && d2 == 0))) crate_pool_note_off(&c->role.pool, d1);
        else if (kind == 0xB0) {
            if (CRATE_EMBED_ROLE_INSTRUMENT && (d1 == 120 || d1 == 123)) crate_pool_all_notes_off(&c->role.pool);
            apply_cc(c, d1, d2);
        }
    }
}

/* Processes in chunks of CRATE_FW_MAX_FRAMES, so the host's block can be any
 * length and the context's buffers stay small (a RAM-tight host builds with
 * a short chunk). */
void crate_fw_process(int16_t *interleaved, int frames) {
    crate_fw_ctx *c = g_ctx;
    if (!c) return;
    while (frames > 0) {
        int n = frames > CRATE_FW_MAX_FRAMES ? CRATE_FW_MAX_FRAMES : frames;

        for (int i = 0; i < n; i++) c->in[i] = (float)interleaved[i * 2] * (1.0f / 32768.0f);

        if (CRATE_EMBED_ROLE_INSTRUMENT) {
            crate_pool_render(&c->role.pool, c->rate, n, c->out_l, c->out_r, NULL);
        } else {
            int wrote = crate_render(&c->role.state, c->rate, n, c->out_l, c->out_r, c->in, NULL, NULL, NULL, NULL);
            if (!wrote) for (int i = 0; i < n; i++) c->out_r[i] = c->out_l[i];
        }

        for (int i = 0; i < n; i++) {
            float l = c->out_l[i], r = c->out_r[i];
            if (l > 1.0f) l = 1.0f; else if (l < -1.0f) l = -1.0f;
            if (r > 1.0f) r = 1.0f; else if (r < -1.0f) r = -1.0f;
            interleaved[i * 2]     = (int16_t)(l * 32767.0f);
            interleaved[i * 2 + 1] = (int16_t)(r * 32767.0f);
        }
        interleaved += n * 2;
        frames -= n;
    }
}

void crate_fw_process_float(const float *in, float *out_l, float *out_r, int frames) {
    crate_fw_ctx *c = g_ctx;
    if (!c) return;
    while (frames > 0) {
        int n = frames > CRATE_FW_MAX_FRAMES ? CRATE_FW_MAX_FRAMES : frames;
        for (int i = 0; i < n; i++) c->in[i] = in[i];
        if (CRATE_EMBED_ROLE_INSTRUMENT) {
            crate_pool_render(&c->role.pool, c->rate, n, c->out_l, c->out_r, NULL);
        } else {
            int wrote = crate_render(&c->role.state, c->rate, n, c->out_l, c->out_r, c->in, NULL, NULL, NULL, NULL);
            if (!wrote) for (int i = 0; i < n; i++) c->out_r[i] = c->out_l[i];
        }
        for (int i = 0; i < n; i++) { out_l[i] = c->out_l[i]; out_r[i] = c->out_r[i]; }
        in += n; out_l += n; out_r += n;
        frames -= n;
    }
}
