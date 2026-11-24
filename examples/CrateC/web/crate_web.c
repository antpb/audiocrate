/*
 * CrateC for the browser: one crate patch as one audio kernel.
 *
 * The web plays a crate patch (homecrate's crate AU) from the compiled graph
 * saved in its slot. The JS interpreter (`asl/compile.ts`) is the reference
 * and runs anywhere, but a session with several eight-voice pads is more than
 * one audio thread can interpret in time. This is the same plan run by the C
 * interpreter, compiled to WASM: an instrument is a `crate_pool` (voice
 * allocation, retirement, the split bus), an effect is one `crate_state`.
 *
 * The graph arrives as the compiled document's JSON and is built into a plan
 * here, with `host/crate_build.c`. A device never parses JSON; a browser
 * already has the text in hand, and building in the kernel keeps the plan
 * format out of the JS side entirely.
 *
 * Every handle owns its arena. Memory is sized by trying: a pad with a
 * desktop-length delay per voice needs megabytes, a bitcrusher kilobytes, and
 * the arena is doubled until the plan's state fits.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "crate.h"
#include "crate_build.h"
#include "crate_pool.h"
#include "json.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define CRATE_WEB_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define CRATE_WEB_EXPORT
#endif

#define CRATE_WEB_ARENA_START (1u << 20)
#define CRATE_WEB_ARENA_LIMIT (512u << 20)

typedef struct crate_web {
    int instrument;
    double sample_rate;
    int max_frames;
    void *blob;
    crate_plan plan;
    void *arena_memory;
    crate_arena arena;
    crate_pool pool;
    crate_state state;
    crate_transport transport;
    int param_count;
    int *voice_index;
    int *bus_index;
    const char **param_names;
    float *in_l;
    float *in_r;
    float *out_l;
    float *out_r;
} crate_web;

static char last_error[256];

static void set_error(const char *message) {
    snprintf(last_error, sizeof last_error, "%s", message);
}

CRATE_WEB_EXPORT const char *crateweb_last_error(void) { return last_error; }

/* Sample tables for the next `crateweb_create`, referred to from the graph as
 * `{ "ext": n }` (crate_build.h). `tables` is `count` (pointer, length) pairs
 * in this module's memory; the build copies what it uses, so the caller may
 * free them after. NULL clears. */
CRATE_WEB_EXPORT void crateweb_set_tables(const crate_build_table *tables, int count) {
    crate_build_set_external_tables(tables, count);
}

static int build_runtime(crate_web *w, int polyphony, uint32_t seed) {
    for (size_t bytes = CRATE_WEB_ARENA_START; bytes <= CRATE_WEB_ARENA_LIMIT; bytes *= 2) {
        free(w->arena_memory);
        w->arena_memory = malloc(bytes);
        if (!w->arena_memory) break;
        crate_arena_init(&w->arena, w->arena_memory, bytes);
        if (w->instrument) {
            if (crate_pool_init(&w->pool, &w->plan, &w->arena, polyphony, seed, w->max_frames) == 0 &&
                crate_pool_prepare(&w->pool, w->sample_rate) == 0)
                return 0;
        } else {
            if (crate_state_init(&w->state, &w->plan, &w->arena, seed) == 0 &&
                crate_state_prepare(&w->state, w->sample_rate) == 0)
                return 0;
        }
    }
    set_error("crate: the patch needs more memory than a kernel may take");
    return -1;
}

static void destroy(crate_web *w) {
    if (!w) return;
    free(w->arena_memory);
    free(w->blob);
    free(w->voice_index);
    free(w->bus_index);
    free(w->param_names);
    free(w->in_l);
    free(w->in_r);
    free(w->out_l);
    free(w->out_r);
    free(w);
}

/*
 * `graph_json` is the compiled document's `graph` (format 1 or 2). `instrument`
 * picks a voice pool over a single state. Returns a handle, or 0 with
 * `crateweb_last_error` set.
 */
CRATE_WEB_EXPORT crate_web *crateweb_create(const char *graph_json, int length, int instrument, int polyphony,
                                            double sample_rate, int max_frames, uint32_t seed) {
    last_error[0] = 0;
    char error[256] = {0};
    json_value *graph = json_parse(graph_json, (size_t)length, error, sizeof error);
    /* Whatever happens, the tables were for this build only. */
    if (!graph) {
        set_error(error[0] ? error : "crate: the graph is not JSON");
        return 0;
    }
    crate_web *w = calloc(1, sizeof *w);
    if (!w) {
        json_free(graph);
        set_error("crate: out of memory");
        return 0;
    }
    w->instrument = instrument != 0;
    w->sample_rate = sample_rate;
    w->max_frames = max_frames > 0 ? max_frames : 128;
    size_t size = 0;
    w->blob = crate_build_plan(graph, &size, error, sizeof error);
    json_free(graph);
    crate_build_set_external_tables(NULL, 0);
    if (!w->blob) {
        set_error(error[0] ? error : "crate: the graph did not build");
        destroy(w);
        return 0;
    }
    if (crate_plan_open(&w->plan, w->blob, size) != 0) {
        set_error("crate: the built plan did not open");
        destroy(w);
        return 0;
    }
    if (polyphony < 1) polyphony = 1;
    if (polyphony > CRATE_MAX_VOICES) polyphony = CRATE_MAX_VOICES;
    if (build_runtime(w, polyphony, seed) != 0) {
        destroy(w);
        return 0;
    }
    crate_transport_default(&w->transport);

    /* One table of every param either half reads. A split instrument's voice
     * plan and bus plan number their params separately, and the bus reads
     * names the voices never do (its level, its limiter): a table of the
     * voice plan alone left those at zero and the instrument silent. */
    int voice_count = (int)w->plan.h->param_count;
    const crate_plan *bus = w->instrument && w->pool.has_bus ? &w->pool.bus_plan : NULL;
    int bus_count = bus ? (int)bus->h->param_count : 0;
    int capacity = voice_count + bus_count + 1;
    w->voice_index = malloc(sizeof(int) * (size_t)capacity);
    w->bus_index = malloc(sizeof(int) * (size_t)capacity);
    w->param_names = malloc(sizeof(char *) * (size_t)capacity);
    if (!w->voice_index || !w->bus_index || !w->param_names) {
        set_error("crate: out of memory");
        destroy(w);
        return 0;
    }
    for (int i = 0; i < voice_count; i++) {
        const char *name = crate_plan_param_name(&w->plan, i);
        w->param_names[w->param_count] = name;
        w->voice_index[w->param_count] = i;
        w->bus_index[w->param_count] = bus ? crate_plan_param_index(bus, name) : -1;
        w->param_count++;
    }
    for (int i = 0; i < bus_count; i++) {
        const char *name = crate_plan_param_name(bus, i);
        if (crate_plan_param_index(&w->plan, name) >= 0) continue;
        w->param_names[w->param_count] = name;
        w->voice_index[w->param_count] = -1;
        w->bus_index[w->param_count] = i;
        w->param_count++;
    }
    size_t block = sizeof(float) * (size_t)w->max_frames;
    w->in_l = calloc(1, block);
    w->in_r = calloc(1, block);
    w->out_l = calloc(1, block);
    w->out_r = calloc(1, block);
    if (!w->in_l || !w->in_r || !w->out_l || !w->out_r) {
        set_error("crate: out of memory");
        destroy(w);
        return 0;
    }
    return w;
}

CRATE_WEB_EXPORT void crateweb_destroy(crate_web *w) { destroy(w); }

CRATE_WEB_EXPORT int crateweb_param_count(crate_web *w) { return w->param_count; }
CRATE_WEB_EXPORT const char *crateweb_param_name(crate_web *w, int index) {
    return index >= 0 && index < w->param_count ? w->param_names[index] : "";
}

/* A host's change: glides when the graph smooths the param, lands otherwise. */
CRATE_WEB_EXPORT void crateweb_set_param(crate_web *w, int index, double value) {
    if (index < 0 || index >= w->param_count) return;
    if (w->instrument) crate_pool_glide_param_index(&w->pool, w->voice_index[index], w->bus_index[index], value);
    else crate_glide_param_index(&w->state, w->voice_index[index], value);
}

CRATE_WEB_EXPORT void crateweb_note_on(crate_web *w, int note, double velocity) {
    if (w->instrument) crate_pool_note_on(&w->pool, note, velocity);
}
CRATE_WEB_EXPORT void crateweb_note_off(crate_web *w, int note) {
    if (w->instrument) crate_pool_note_off(&w->pool, note);
}
CRATE_WEB_EXPORT void crateweb_all_notes_off(crate_web *w) {
    if (w->instrument) crate_pool_all_notes_off(&w->pool);
}
CRATE_WEB_EXPORT int crateweb_active_voices(crate_web *w) {
    return w->instrument ? crate_pool_active_voices(&w->pool) : 1;
}

/* The song's position at the start of the coming block. */
CRATE_WEB_EXPORT void crateweb_set_transport(crate_web *w, double beats, double bpm, int playing,
                                             double beats_per_bar, double beat_unit) {
    w->transport.beats = beats;
    w->transport.bpm = bpm;
    w->transport.playing = playing;
    w->transport.beats_per_bar = beats_per_bar;
    w->transport.beat_unit = beat_unit > 0 ? beat_unit : 4;
}

/* 0 in_l, 1 in_r, 2 out_l, 3 out_r: blocks of `max_frames` floats. */
CRATE_WEB_EXPORT float *crateweb_buffer(crate_web *w, int which) {
    switch (which) {
    case 0: return w->in_l;
    case 1: return w->in_r;
    case 2: return w->out_l;
    default: return w->out_r;
    }
}

/*
 * Renders `frames` (at most `max_frames`) into the out buffers, always both
 * channels. An effect reads the in buffers; `stereo_in` 0 means the right
 * input is the left (a mono source), which lets a mirrorable graph run once.
 */
CRATE_WEB_EXPORT void crateweb_process(crate_web *w, int frames, int stereo_in) {
    if (frames > w->max_frames) frames = w->max_frames;
    if (frames <= 0) return;
    if (w->instrument) {
        crate_pool_render(&w->pool, w->sample_rate, frames, w->out_l, w->out_r, &w->transport);
    } else {
        int wrote = crate_render(&w->state, w->sample_rate, frames, w->out_l, w->out_r, w->in_l,
                                 stereo_in ? w->in_r : NULL, &w->transport, NULL, NULL);
        if (!wrote) memcpy(w->out_r, w->out_l, sizeof(float) * (size_t)frames);
    }
}
