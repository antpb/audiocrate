/*
 * cratepack: the factory library (or any list of compiled plugin documents)
 * into one pack a device keeps in flash.
 *
 *   cratepack factory-compiled.json out.pack
 *       [--rate 44100] [--budget 131072] [--voices 8]
 *       [--bpm-min 60] [--bpm-max 200] [--mono-input] [--report]
 *
 * Two things happen to each patch on the way in.
 *
 * Delay lines are fitted. A line is declared with a maximum time
 * (`maxTimeSec`) chosen for a desktop, typically seconds. What a patch can
 * actually ask of it is bounded by its controls: a time knob's range, a
 * tempo-synced division at the slowest tempo the device allows. Interval
 * arithmetic over the subgraph feeding the line's time input finds that
 * bound, and the line is sized to it. The bound is an upper bound, so no
 * setting of any control reads past the end of the fitted line: the sound
 * is unchanged, only the memory it was never going to touch is gone. A time
 * input the analysis cannot bound keeps its declared line.
 *
 * The footprint is measured, not estimated: each patch is loaded through the
 * same `crate_engine_load` a device runs, into an arena, and what the arena
 * used is written into the entry. Build this tool with the device's sample
 * type and line storage (the Makefile does: float, int16) or the number
 * describes a different machine. Pointers are 8 bytes here and 4 on a 32-bit
 * target, so the figure errs high, which is the safe direction.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "crate.h"
#include "crate_build.h"
#include "crate_engine.h"
#include "crate_pack.h"
#include "json.h"

/* ---------------------------------------------------------------------------
 * Intervals
 * ------------------------------------------------------------------------ */

typedef struct interval {
    double lo, hi;
} interval;

static const interval UNBOUNDED = { -INFINITY, INFINITY };

static interval iv(double lo, double hi) {
    interval r = { lo < hi ? lo : hi, lo < hi ? hi : lo };
    return r;
}

static interval hull(interval a, interval b) {
    interval r = { a.lo < b.lo ? a.lo : b.lo, a.hi > b.hi ? a.hi : b.hi };
    return r;
}

static int bounded(interval a) { return isfinite(a.lo) && isfinite(a.hi); }

static interval iv_add(interval a, interval b) {
    if (!bounded(a) || !bounded(b)) return UNBOUNDED;
    return iv(a.lo + b.lo, a.hi + b.hi);
}

static interval iv_mul(interval a, interval b) {
    if (a.lo == 0 && a.hi == 0) return a;
    if (b.lo == 0 && b.hi == 0) return b;
    if (!bounded(a) || !bounded(b)) return UNBOUNDED;
    double p[4] = { a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi };
    interval r = { p[0], p[0] };
    for (int i = 1; i < 4; i++) {
        if (p[i] < r.lo) r.lo = p[i];
        if (p[i] > r.hi) r.hi = p[i];
    }
    return r;
}

typedef struct analysis {
    const crate_plan *plan;
    const json_value *params; /* the compiled document's param descriptors */
    double bpm_min, bpm_max;
    interval *memo;
    uint8_t *state; /* 0 unvisited, 1 visiting, 2 done */
} analysis;

static interval param_interval(const analysis *a, const char *name) {
    const json_value *d = json_get(a->params, name);
    if (d) {
        const json_value *lo = json_get(d, "min"), *hi = json_get(d, "max");
        if (json_is_number(lo) && json_is_number(hi)) return iv(json_number(lo, 0), json_number(hi, 0));
    }
    /* What a voice pool writes. */
    if (strcmp(name, "note") == 0) return iv(0, 127);
    if (strcmp(name, "velocity") == 0) return iv(0, 1);
    return UNBOUNDED;
}

static interval node_interval(analysis *a, int slot);

static interval in_iv(analysis *a, const crate_node *n, int input) {
    return n->in[input] < 0 ? iv(0, 0) : node_interval(a, n->in[input]);
}

static interval compute_interval(analysis *a, const crate_node *n) {
    const crate_plan *plan = a->plan;
    switch (n->kind) {
    case CK_CONST: return iv(n->c, n->c);
    case CK_PARAM: return n->ix == CRATE_NONE ? iv(0, 0) : param_interval(a, crate_plan_param_name(plan, n->ix));
    case CK_MUL: return iv_mul(in_iv(a, n, CI_A), in_iv(a, n, CI_B));
    case CK_ADD: return iv_add(in_iv(a, n, CI_A), in_iv(a, n, CI_B));
    case CK_MIX: {
        interval sum = iv(0, 0);
        for (int i = 0; i < n->list_count; i++) sum = iv_add(sum, node_interval(a, plan->index[n->list_off + (uint32_t)i]));
        return sum;
    }
    case CK_RANGE: {
        interval s = in_iv(a, n, CI_SOURCE);
        if (!bounded(s)) return UNBOUNDED;
        double span = n->range_max - n->range_min;
        return iv(n->range_min + ((s.lo + 1) / 2) * span, n->range_min + ((s.hi + 1) / 2) * span);
    }
    case CK_SELECT: return hull(in_iv(a, n, CI_A), in_iv(a, n, CI_B));
    case CK_TO_FREQUENCY: {
        interval note = in_iv(a, n, CI_NOTE);
        if (!bounded(note)) return UNBOUNDED;
        return iv(440 * pow(2, (note.lo - 69) / 12), 440 * pow(2, (note.hi - 69) / 12));
    }
    case CK_TRANSPORT:
        switch (n->m) {
        case 2: return iv(a->bpm_min, a->bpm_max);
        case 3: case 4: case 5: return iv(0, 1);
        case 6: {
            interval len = in_iv(a, n, CI_LENGTH);
            if (!bounded(len)) return UNBOUNDED;
            double lo = len.lo < 0 ? 0 : len.lo;
            double hi = len.hi < 0 ? 0 : len.hi;
            return iv(lo * 60 / a->bpm_max, hi * 60 / a->bpm_min);
        }
        case 7: {
            if (n->a_len == 0) return iv(1, 1);
            const double *t = plan->numbers + n->a_off;
            interval r = iv(t[0], t[0]);
            for (int i = 1; i < n->a_len; i++) r = hull(r, iv(t[i], t[i]));
            return r;
        }
        case 8: case 9: return iv(4, 4);
        default: return UNBOUNDED;
        }
    case CK_OSC: case CK_LFO: case CK_NOISE: case CK_RANDOM: case CK_CLIP:
        return iv(-1, 1);
    case CK_ADSR: case CK_DAHDSR: {
        interval v = in_iv(a, n, CI_TRIGGER);
        return bounded(v) ? iv(0, v.hi > 1 ? v.hi : 1) : UNBOUNDED;
    }
    case CK_SLEW: case CK_SAMPLE_HOLD: case CK_ONE_POLE_LOWPASS: case CK_DOWNSAMPLE:
        return hull(in_iv(a, n, CI_INPUT), iv(0, 0));
    case CK_SEQUENCER: {
        interval r = iv(0, 0);
        for (int i = 0; i < n->list_count; i++) r = hull(r, node_interval(a, plan->index[n->list_off + (uint32_t)i]));
        return r;
    }
    case CK_WAVESHAPE: {
        if (n->a_len < 2) return in_iv(a, n, CI_INPUT);
        const double *c = plan->numbers + n->a_off;
        interval r = iv(c[0], c[0]);
        for (int i = 1; i < n->a_len; i++) r = hull(r, iv(c[i], c[i]));
        return r;
    }
    case CK_QUANTIZE: {
        interval x = in_iv(a, n, CI_INPUT);
        return bounded(x) ? iv(x.lo - 12, x.hi + 12) : UNBOUNDED;
    }
    case CK_COMPARE: case CK_LOGIC: case CK_TRIGGER: case CK_PULSE: case CK_CLOCK:
    case CK_CLOCK_DIVIDE: case CK_CLOCK_MULTIPLY: case CK_EUCLIDEAN: case CK_IMPULSE: case CK_FLIP_FLOP:
    case CK_LANE:
        return iv(0, 1);
    case CK_RECTIFY: {
        interval x = in_iv(a, n, CI_INPUT);
        if (!bounded(x)) return UNBOUNDED;
        double m = fabs(x.lo) > fabs(x.hi) ? fabs(x.lo) : fabs(x.hi);
        return iv(0, m);
    }
    default:
        return UNBOUNDED;
    }
}

static interval node_interval(analysis *a, int slot) {
    if (a->state[slot] == 2) return a->memo[slot];
    if (a->state[slot] == 1) return UNBOUNDED; /* a cycle cannot be bounded this way */
    a->state[slot] = 1;
    interval r = compute_interval(a, &a->plan->nodes[slot]);
    a->memo[slot] = r;
    a->state[slot] = 2;
    return r;
}

/* Sizes every delay and reverse line in a plan blob (and its bus) to what
 * its time input can reach. Returns how many lines got smaller. */
static int fit_lines(void *blob, const json_value *params, double rate, double bpm_min, double bpm_max,
                     long *saved_samples) {
    crate_plan plan;
    if (crate_plan_open(&plan, blob, ((crate_plan_header *)blob)->size) != 0) return 0;
    int count = plan.h->node_count;
    analysis a = { &plan, params, bpm_min, bpm_max, calloc((size_t)count, sizeof(interval)), calloc((size_t)count, 1) };
    crate_node *nodes = (crate_node *)((uint8_t *)blob + plan.h->nodes_off);
    int fitted = 0;
    for (int i = 0; i < count; i++) {
        crate_node *n = &nodes[i];
        if (n->kind != CK_DELAY && n->kind != CK_REVERSE) continue;
        interval t = node_interval(&a, n->in[CI_TIME_SEC] < 0 ? i : n->in[CI_TIME_SEC]);
        if (n->in[CI_TIME_SEC] < 0) t = iv(0, 0);
        if (!bounded(t)) continue;
        double reach = t.hi < 1 / rate ? 1 / rate : t.hi;
        double declared = n->kind == CK_REVERSE && n->c <= 0 ? 2 : n->c;
        if (reach < declared) {
            *saved_samples += (long)ceil((declared - reach) * rate);
            n->c = reach;
            fitted++;
        }
    }
    free(a.memo);
    free(a.state);
    if (plan.bus_blob) fitted += fit_lines((void *)plan.bus_blob, params, rate, bpm_min, bpm_max, saved_samples);
    return fitted;
}

/* ---------------------------------------------------------------------------
 * Writing
 * ------------------------------------------------------------------------ */

typedef struct out_bytes {
    uint8_t *data;
    size_t len, cap;
} out_bytes;

static size_t put(out_bytes *o, const void *src, size_t n, size_t align) {
    size_t at = (o->len + align - 1) & ~(align - 1);
    while (at + n > o->cap) {
        o->cap = o->cap ? o->cap * 2 : 1 << 16;
        o->data = (uint8_t *)realloc(o->data, o->cap);
    }
    memset(o->data + o->len, 0, at - o->len);
    if (n) memcpy(o->data + at, src, n);
    o->len = at + n;
    return at;
}

static uint32_t put_string(out_bytes *strings, const char *s) {
    return (uint32_t)put(strings, s, strlen(s) + 1, 1);
}

typedef struct staged {
    void *plan;
    size_t plan_size;
    crate_pack_entry entry;
    crate_pack_param *params;
    int fitted;
    int nodes;
} staged;

int main(int argc, char **argv) {
    const char *in_path = NULL, *out_path = NULL;
    double rate = 44100, bpm_min = 60, bpm_max = 200;
    long budget = 128 * 1024;
    int voices = 8, report = 0, mono_input = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--rate") == 0 && i + 1 < argc) rate = atof(argv[++i]);
        else if (strcmp(argv[i], "--budget") == 0 && i + 1 < argc) budget = atol(argv[++i]);
        else if (strcmp(argv[i], "--voices") == 0 && i + 1 < argc) voices = atoi(argv[++i]);
        else if (strcmp(argv[i], "--bpm-min") == 0 && i + 1 < argc) bpm_min = atof(argv[++i]);
        else if (strcmp(argv[i], "--bpm-max") == 0 && i + 1 < argc) bpm_max = atof(argv[++i]);
        else if (strcmp(argv[i], "--report") == 0) report = 1;
        else if (strcmp(argv[i], "--mono-input") == 0) mono_input = 1;
        else if (!in_path) in_path = argv[i];
        else out_path = argv[i];
    }
    if (!in_path || !out_path) {
        fprintf(stderr, "usage: cratepack factory-compiled.json out.pack [--rate hz] [--budget bytes] [--voices n] [--bpm-min n] [--bpm-max n] [--report]\n");
        return 2;
    }

    size_t length = 0;
    char *text = json_read_file(in_path, &length);
    if (!text) { fprintf(stderr, "cannot read %s\n", in_path); return 2; }
    char error[256];
    json_value *doc = json_parse(text, length, error, sizeof error);
    free(text);
    if (!doc) { fprintf(stderr, "%s: %s\n", in_path, error); return 2; }
    const json_value *patches = json_get(doc, "patches");
    if (!patches || patches->type != JSON_ARRAY) { fprintf(stderr, "no patches\n"); return 2; }

    out_bytes strings = { NULL, 0, 0 };
    put(&strings, "", 1, 1);
    int count = patches->count;
    staged *st = (staged *)calloc((size_t)count, sizeof(staged));
    int failures = 0;
    long saved_total = 0;
    for (int i = 0; i < count; i++) {
        const json_value *p = &patches->items[i];
        const json_value *compiled = json_get(p, "compiled");
        const char *id = json_string(json_get(p, "id"), "?");
        st[i].plan = crate_build_plan(json_get(compiled, "graph"), &st[i].plan_size, error, sizeof error);
        if (!st[i].plan) {
            fprintf(stderr, "%s: %s\n", id, error);
            failures++;
            continue;
        }
        st[i].nodes = ((crate_plan_header *)st[i].plan)->node_count;
        const json_value *params = json_get(compiled, "params");
        long saved = 0;
        st[i].fitted = fit_lines(st[i].plan, params, rate, bpm_min, bpm_max, &saved);
        saved_total += saved;

        crate_pack_entry *e = &st[i].entry;
        e->id_off = put_string(&strings, id);
        e->name_off = put_string(&strings, json_string(json_get(p, "name"), id));
        e->category_off = put_string(&strings, json_string(json_get(p, "category"), ""));
        e->role = strcmp(json_string(json_get(compiled, "role"), "insert"), "instrument") == 0 ? CRATE_ROLE_INSTRUMENT : CRATE_ROLE_INSERT;
        {
            const char *slot = json_string(json_get(p, "slot"), "effect");
            e->slot = (uint8_t)(strcmp(slot, "instrument") == 0 ? CRATE_SLOT_INSTRUMENT : strcmp(slot, "either") == 0 ? CRATE_SLOT_EITHER : CRATE_SLOT_EFFECT);
        }
        e->polyphony = (uint16_t)json_number(json_get(compiled, "polyphony"), voices);
        if (e->polyphony > voices) e->polyphony = (uint16_t)voices;
        e->flags = (uint8_t)(st[i].fitted ? CRATE_PACK_LINES_FITTED : 0);
        int pc = params && params->type == JSON_OBJECT ? params->count : 0;
        st[i].params = (crate_pack_param *)calloc((size_t)(pc ? pc : 1), sizeof(crate_pack_param));
        e->param_count = (uint16_t)pc;
        for (int k = 0; k < pc; k++) {
            const json_value *d = &params->items[k];
            crate_pack_param *q = &st[i].params[k];
            q->name_off = put_string(&strings, params->keys[k]);
            q->label_off = put_string(&strings, json_string(json_get(d, "label"), params->keys[k]));
            q->min = (float)json_number(json_get(d, "min"), 0);
            q->max = (float)json_number(json_get(d, "max"), 1);
            q->def = (float)json_number(json_get(d, "default"), q->min);
            q->address = (uint16_t)json_number(json_get(d, "address"), 0xFFFF);
        }
    }

    /* Categories in display order. */
    const json_value *order = json_get(doc, "categoryOrder");
    int category_count = order && order->type == JSON_ARRAY ? order->count : 0;
    uint32_t *category_offs = (uint32_t *)calloc((size_t)(category_count ? category_count : 1), 4);
    for (int k = 0; k < category_count; k++) category_offs[k] = put_string(&strings, json_string(&order->items[k], ""));

    /* Layout: header, entries, params, plans, strings, categories. Written
     * twice: once with every entry available so the engine can load each one
     * and be measured, then again with the measurements in. */
    for (int pass = 0; pass < 2; pass++) {
        out_bytes o = { NULL, 0, 0 };
        crate_pack_header h;
        memset(&h, 0, sizeof h);
        put(&o, &h, sizeof h, 8);
        size_t entries_at = put(&o, NULL, 0, 8);
        for (int i = 0; i < count; i++) put(&o, &st[i].entry, sizeof(crate_pack_entry), 4);
        for (int i = 0; i < count; i++) {
            if (!st[i].plan) continue;
            st[i].entry.params_off = (uint32_t)put(&o, st[i].params, sizeof(crate_pack_param) * st[i].entry.param_count, 4);
            st[i].entry.plan_off = (uint32_t)put(&o, st[i].plan, st[i].plan_size, 8);
            st[i].entry.plan_size = (uint32_t)st[i].plan_size;
            if (pass == 0) {
                st[i].entry.flags |= CRATE_PACK_AVAILABLE;
                st[i].entry.arena_bytes = 0;
            }
        }
        h.strings_off = (uint32_t)put(&o, strings.data, strings.len, 8);
        h.categories_off = (uint32_t)put(&o, category_offs, 4 * (size_t)category_count, 4);
        put(&o, NULL, 0, 8);
        h.magic = CRATE_PACK_MAGIC;
        h.version = CRATE_PACK_VERSION;
        h.count = (uint16_t)count;
        h.size = (uint32_t)o.len;
        h.entries_off = (uint32_t)entries_at;
        h.sample_rate = (uint32_t)rate;
        h.budget_bytes = (uint32_t)budget;
        h.bpm_min = (uint16_t)bpm_min;
        h.bpm_max = (uint16_t)bpm_max;
        h.category_count = (uint16_t)category_count;
        h.flags = (uint16_t)(mono_input ? CRATE_PACK_MEASURED_MONO : 0);
        memcpy(o.data, &h, sizeof h);
        for (int i = 0; i < count; i++) memcpy(o.data + entries_at + (size_t)i * sizeof(crate_pack_entry), &st[i].entry, sizeof(crate_pack_entry));

        if (pass == 0) {
            /* Measure: load each patch through the device path. */
            size_t big = (size_t)256 << 20;
            void *arena = malloc(big);
            crate_engine engine;
            crate_engine_config config;
            crate_engine_default_config(&config);
            config.sample_rate = rate;
            config.max_voices = voices;
            config.mono_input = mono_input;
            if (crate_engine_init(&engine, &config, o.data, o.len, arena, big) != CRATE_ENGINE_OK) {
                fprintf(stderr, "pack did not open\n");
                return 1;
            }
            for (int i = 0; i < count; i++) {
                if (!st[i].plan) continue;
                int rc = crate_engine_load(&engine, i);
                if (rc != CRATE_ENGINE_OK) {
                    fprintf(stderr, "%s: load failed (%d)\n", crate_engine_id(&engine, i), rc);
                    failures++;
                    st[i].entry.flags &= (uint8_t)~CRATE_PACK_AVAILABLE;
                    continue;
                }
                st[i].entry.arena_bytes = (uint32_t)engine.arena.used;
                if ((long)engine.arena.used <= budget) st[i].entry.flags |= CRATE_PACK_AVAILABLE;
                else st[i].entry.flags &= (uint8_t)~CRATE_PACK_AVAILABLE;
            }
            free(arena);
            free(o.data);
            continue;
        }

        FILE *f = fopen(out_path, "wb");
        if (!f) { fprintf(stderr, "cannot write %s\n", out_path); return 2; }
        fwrite(o.data, 1, o.len, f);
        fclose(f);

        int available = 0, fitted_patches = 0;
        long max_bytes = 0;
        for (int i = 0; i < count; i++) {
            available += (st[i].entry.flags & CRATE_PACK_AVAILABLE) != 0;
            fitted_patches += st[i].fitted > 0;
            if ((long)st[i].entry.arena_bytes > max_bytes) max_bytes = st[i].entry.arena_bytes;
        }
        if (report) {
            printf("%-22s %-10s %5s %9s %6s  %s\n", "id", "role", "nodes", "arena KB", "fitted", "status");
            for (int i = 0; i < count; i++) {
                if (!st[i].plan) continue;
                const char *id = (const char *)strings.data + st[i].entry.id_off;
                printf("%-22s %-10s %5d %9.1f %6d  %s\n", id,
                       st[i].entry.role == CRATE_ROLE_INSTRUMENT ? "instrument" : "insert",
                       st[i].nodes, st[i].entry.arena_bytes / 1024.0, st[i].fitted,
                       (st[i].entry.flags & CRATE_PACK_AVAILABLE) ? "ok" : "over budget");
            }
            printf("\n");
        }
        printf("wrote %s: %d patches, %zu KB\n", out_path, count, o.len / 1024);
        printf("  available       %d of %d within %.0f KB at %.0f Hz, %d voices, %s input\n", available, count, budget / 1024.0, rate, voices, mono_input ? "mono" : "stereo");
        printf("  lines fitted    %d patches, %.1f s of line removed\n", fitted_patches, saved_total / rate);
        printf("  largest patch   %.1f KB\n", max_bytes / 1024.0);
        printf("  sample type     %s, lines %s\n", sizeof(crate_real) == 4 ? "float" : "double",
#ifdef CRATE_LINE_INT16
               "int16"
#else
               "float"
#endif
        );
        free(o.data);
    }

    for (int i = 0; i < count; i++) {
        free(st[i].plan);
        free(st[i].params);
    }
    free(st);
    free(strings.data);
    free(category_offs);
    json_free(doc);
    return failures ? 1 : 0;
}
