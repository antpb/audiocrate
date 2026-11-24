#include "crate_build.h"

#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "crate.h"

static const crate_build_table *g_external = NULL;
static int g_external_count = 0;

void crate_build_set_external_tables(const crate_build_table *tables, int count) {
    g_external = tables;
    g_external_count = tables ? count : 0;
}

/* ---------------------------------------------------------------------------
 * Small growable helpers
 * ------------------------------------------------------------------------ */

typedef struct strset {
    char **items;
    int count, cap;
} strset;

static int strset_add(strset *s, const char *v) {
    for (int i = 0; i < s->count; i++) {
        if (strcmp(s->items[i], v) == 0) return i;
    }
    if (s->count == s->cap) {
        s->cap = s->cap ? s->cap * 2 : 8;
        s->items = (char **)realloc(s->items, sizeof(char *) * (size_t)s->cap);
    }
    s->items[s->count] = strdup(v);
    return s->count++;
}

static int strset_find(const strset *s, const char *v) {
    for (int i = 0; i < s->count; i++) {
        if (strcmp(s->items[i], v) == 0) return i;
    }
    return -1;
}

static int cmp_str(const void *a, const void *b) {
    return strcmp(*(char *const *)a, *(char *const *)b);
}

static void strset_sort(strset *s) { qsort(s->items, (size_t)s->count, sizeof(char *), cmp_str); }

static void strset_free(strset *s) {
    for (int i = 0; i < s->count; i++) free(s->items[i]);
    free(s->items);
}

/* id -> value map, open addressing. Document ids span a whole authoring
 * session, so they are never dense. */
typedef struct idmap {
    long long *keys;
    void **vals;
    int cap, count;
} idmap;

static void idmap_init(idmap *m, int expect) {
    m->cap = 64;
    while (m->cap < expect * 2) m->cap *= 2;
    m->keys = (long long *)malloc(sizeof(long long) * (size_t)m->cap);
    m->vals = (void **)calloc((size_t)m->cap, sizeof(void *));
    for (int i = 0; i < m->cap; i++) m->keys[i] = LLONG_MIN;
    m->count = 0;
}

static void idmap_free(idmap *m) {
    free(m->keys);
    free(m->vals);
}

static void idmap_put(idmap *m, long long key, void *val);

static void idmap_grow(idmap *m) {
    idmap bigger;
    bigger.cap = m->cap * 2;
    bigger.keys = (long long *)malloc(sizeof(long long) * (size_t)bigger.cap);
    bigger.vals = (void **)calloc((size_t)bigger.cap, sizeof(void *));
    for (int i = 0; i < bigger.cap; i++) bigger.keys[i] = LLONG_MIN;
    bigger.count = 0;
    for (int i = 0; i < m->cap; i++) {
        if (m->keys[i] != LLONG_MIN) idmap_put(&bigger, m->keys[i], m->vals[i]);
    }
    idmap_free(m);
    *m = bigger;
}

static void *idmap_get(const idmap *m, long long key) {
    unsigned long long h = (unsigned long long)key * 0x9E3779B97F4A7C15ull;
    int i = (int)(h & (unsigned long long)(m->cap - 1));
    while (m->keys[i] != LLONG_MIN) {
        if (m->keys[i] == key) return m->vals[i];
        i = (i + 1) & (m->cap - 1);
    }
    return NULL;
}

static void idmap_put(idmap *m, long long key, void *val) {
    if ((m->count + 1) * 2 > m->cap) idmap_grow(m);
    unsigned long long h = (unsigned long long)key * 0x9E3779B97F4A7C15ull;
    int i = (int)(h & (unsigned long long)(m->cap - 1));
    while (m->keys[i] != LLONG_MIN) {
        if (m->keys[i] == key) { m->vals[i] = val; return; }
        i = (i + 1) & (m->cap - 1);
    }
    m->keys[i] = key;
    m->vals[i] = val;
    m->count++;
}

/* ---------------------------------------------------------------------------
 * The planned node, host side
 * ------------------------------------------------------------------------ */

typedef struct bnode {
    crate_node n;
    char *name;      /* param / port name, tap id */
    double *a;
    double *b;
    float *table;
    int *list;
    long long source_id;
} bnode;

typedef struct builder {
    bnode *nodes;
    int count, cap;
    idmap planned;   /* source id -> bnode index + 1 */
    idmap defined;   /* source id -> json node */
    strset params, ports, taps;
    int *tap_windows; /* parallel to taps, grown with it */
    int uses_lane, uses_random, reads_scalar_input;
    char *error;
    size_t error_size;
    int failed;
} builder;

static void berror(builder *b, const char *fmt, const char *detail) {
    if (b->failed) return;
    b->failed = 1;
    if (b->error && b->error_size) snprintf(b->error, b->error_size, fmt, detail);
}

static int kind_from_name(const char *name) {
    for (int i = 0; i < CK_COUNT; i++) {
        if (strcmp(crate_kind_names[i], name) == 0) return i;
    }
    return -1;
}

static int input_from_name(const char *name) {
    for (int i = 0; i < CI_COUNT; i++) {
        if (strcmp(crate_input_names[i], name) == 0) return i;
    }
    return -1;
}

static const char *pstr(const json_value *params, const char *key) {
    return json_string(json_get(params, key), NULL);
}

static int streq(const char *a, const char *b) { return a && strcmp(a, b) == 0; }

/* `planMode` in Plan.swift. */
static int plan_mode(const json_value *p, int kind) {
    const char *s;
    switch (kind) {
    case CK_OSC:
    case CK_LFO:
        s = pstr(p, kind == CK_OSC ? "type" : "shape");
        if (streq(s, "saw")) return 1;
        if (streq(s, "square")) return 2;
        if (streq(s, "triangle")) return 3;
        if (streq(s, "pulse")) return 4;
        if (streq(s, "varshape")) return 5;
        if (streq(s, "supersquare")) return 6;
        if (streq(s, "harmonic")) return 7;
        return 0;
    case CK_CLIP: return streq(pstr(p, "mode"), "hard") ? 1 : 0;
    case CK_RECTIFY: return streq(pstr(p, "mode"), "half") ? 1 : 0;
    case CK_COMPARE: return streq(pstr(p, "mode"), "lt") ? 1 : 0;
    case CK_SVF:
        s = pstr(p, "mode");
        if (streq(s, "highpass")) return 1;
        if (streq(s, "bandpass")) return 2;
        return 0;
    case CK_LOGIC:
        s = pstr(p, "mode");
        if (streq(s, "or")) return 1;
        if (streq(s, "xor")) return 2;
        if (streq(s, "not")) return 3;
        return 0;
    case CK_FILTER_SLOPE: return streq(pstr(p, "mode"), "highpass") ? 1 : 0;
    case CK_NOISE:
        s = pstr(p, "color");
        if (streq(s, "pink")) return 1;
        if (streq(s, "brown")) return 2;
        if (streq(s, "blue")) return 3;
        if (streq(s, "violet")) return 4;
        if (streq(s, "grey")) return 5;
        return 0;
    case CK_PAN_LAW: return streq(pstr(p, "channel"), "right") ? 1 : 0;
    case CK_RANDOM: return streq(pstr(p, "mode"), "smooth") ? 1 : 0;
    case CK_TRANSPORT:
        s = pstr(p, "field");
        if (streq(s, "bars")) return 1;
        if (streq(s, "bpm")) return 2;
        if (streq(s, "playing")) return 3;
        if (streq(s, "phase")) return 4;
        if (streq(s, "pulse")) return 5;
        if (streq(s, "seconds")) return 6;
        if (streq(s, "division")) return 7;
        if (streq(s, "beatsPerBar")) return 8;
        if (streq(s, "beatUnit")) return 9;
        return 0;
    case CK_KERNEL:
        /* 1 source, 2 source that goes silent when nothing is bound, 0 seam. */
        if (!streq(pstr(p, "mode"), "source")) return 0;
        return streq(pstr(p, "fallback"), "silence") ? 2 : 1;
    case CK_PORT: {
        const json_value *ch = json_get(p, "channel");
        return json_is_number(ch) ? (int)json_number(ch, -1) : -1;
    }
    case CK_PITCH_SHIFT: return streq(pstr(p, "unit"), "st") ? 1 : 0;
    case CK_LOOPER:
        s = pstr(p, "field");
        if (streq(s, "start")) return 1;
        if (streq(s, "end")) return 2;
        return 0;
    case CK_PITCH:
        s = pstr(p, "field");
        if (streq(s, "midi")) return 1;
        if (streq(s, "cents")) return 2;
        if (streq(s, "gate")) return 3;
        return 0;
    case CK_SAMPLE_PLAY: {
        const json_value *vg = json_get(p, "voiceGate");
        return vg && vg->type == JSON_BOOL && !vg->boolean ? 1 : 0;
    }
    default: return 0;
    }
}

/* `planConst` in Plan.swift. */
static double plan_const(const json_value *p, int kind) {
    switch (kind) {
    case CK_CAPTURE: return json_number(json_get(p, "windowSize"), 0);
    case CK_DELAY: return json_number(json_get(p, "maxTimeSec"), 0);
    case CK_REVERSE: return json_number(json_get(p, "maxTimeSec"), 2);
    case CK_LOOPER: return json_number(json_get(p, "maxTimeSec"), 4);
    case CK_FILTER_SLOPE: {
        double poles = round(json_number(json_get(p, "poles"), 2));
        return poles < 1 ? 1 : poles > 4 ? 4 : poles;
    }
    case CK_CONST: return json_number(json_get(p, "value"), 0);
    case CK_WAVETABLE: return json_number(json_get(p, "frameSize"), 0);
    default: return 0;
    }
}

/* A numeric array, or NULL if absent or anything inside is not a number,
 * as `ASLValue.numbers`. */
static double *numbers(const json_value *v, int *count) {
    *count = 0;
    if (!v || v->type != JSON_ARRAY) return NULL;
    for (int i = 0; i < v->count; i++) {
        if (!json_is_number(&v->items[i])) return NULL;
    }
    double *out = (double *)malloc(sizeof(double) * (size_t)(v->count ? v->count : 1));
    for (int i = 0; i < v->count; i++) out[i] = json_number(&v->items[i], 0);
    *count = v->count;
    return out;
}

static double *literal(const double *values, int count, int *out_count) {
    double *out = (double *)malloc(sizeof(double) * (size_t)count);
    memcpy(out, values, sizeof(double) * (size_t)count);
    *out_count = count;
    return out;
}

static const json_value *resolve(builder *b, const json_value *doc) {
    if (!doc || doc->type != JSON_OBJECT) return NULL;
    if (json_get(doc, "kind")) return doc;
    const json_value *ref = json_get(doc, "ref");
    if (!json_is_number(ref)) return NULL;
    const json_value *found = (const json_value *)idmap_get(&b->defined, (long long)json_number(ref, 0));
    if (!found) berror(b, "the graph refers to node %s, which it never defines", "(ref)");
    return found;
}

static void collect_defined(builder *b, const json_value *doc) {
    if (!doc || doc->type != JSON_OBJECT || !json_get(doc, "kind")) return;
    long long id = (long long)json_number(json_get(doc, "id"), 0);
    if (idmap_get(&b->defined, id)) return;
    idmap_put(&b->defined, id, (void *)doc);
    const json_value *inputs = json_get(doc, "inputs");
    if (inputs && inputs->type == JSON_OBJECT) {
        for (int i = 0; i < inputs->count; i++) collect_defined(b, &inputs->items[i]);
    }
    const json_value *list = json_get(doc, "list");
    if (list && list->type == JSON_ARRAY) {
        for (int i = 0; i < list->count; i++) collect_defined(b, &list->items[i]);
    }
}

static int visit(builder *b, const json_value *raw) {
    if (b->failed) return -1;
    const json_value *doc = resolve(b, raw);
    if (!doc) { berror(b, "%s", "a graph node is not an object"); return -1; }
    long long id = (long long)json_number(json_get(doc, "id"), 0);
    void *existing = idmap_get(&b->planned, id);
    if (existing) return (int)(intptr_t)existing - 1;

    const char *kind_name = json_string(json_get(doc, "kind"), "");
    int kind = kind_from_name(kind_name);
    if (kind < 0) { berror(b, "unknown ASL node kind \"%s\"", kind_name); return -1; }
    const json_value *p = json_get(doc, "params");

    if (b->count == b->cap) {
        b->cap = b->cap ? b->cap * 2 : 32;
        b->nodes = (bnode *)realloc(b->nodes, sizeof(bnode) * (size_t)b->cap);
    }
    if (b->count >= 0x7FFF) { berror(b, "%s", "graph has more nodes than a plan can index"); return -1; }
    int slot = b->count++;
    bnode *bn = &b->nodes[slot];
    memset(bn, 0, sizeof *bn);
    bn->source_id = id;
    bn->n.kind = (uint8_t)kind;
    bn->n.m = (int8_t)plan_mode(p, kind);
    bn->n.c = plan_const(p, kind);
    bn->n.ix = CRATE_NONE;
    for (int k = 0; k < CI_COUNT; k++) bn->n.in[k] = -1;

    switch (kind) {
    case CK_METER:
    case CK_CAPTURE: bn->name = strdup(json_string(json_get(p, "id"), "")); break;
    case CK_PARAM:
    case CK_PORT: bn->name = strdup(json_string(json_get(p, "name"), "")); break;
    default: break;
    }

    /* Tables: an inline sample box, else an inline table. A box that names a
     * file carries no samples here; a device has no file library. Either may
     * instead be `{ "ext": n }`, table n of those set with
     * `crate_build_set_external_tables`: a host holding the samples as floats
     * (the browser) passes them without writing them out as JSON text. */
    if (kind == CK_WAVETABLE || kind == CK_SAMPLE_PLAY || kind == CK_GRAIN) {
        const json_value *box = json_get(p, "box");
        const json_value *src = NULL;
        double rate = 0;
        const json_value *ext = json_get(box ? json_get(box, "samples") : json_get(p, "table"), "ext");
        if (!ext && box) ext = json_get(json_get(p, "table"), "ext");
        if (ext && json_is_number(ext)) {
            int index = (int)json_number(ext, -1);
            if (index >= 0 && index < g_external_count && g_external[index].len > 0) {
                bn->table = (float *)malloc(sizeof(float) * g_external[index].len);
                memcpy(bn->table, g_external[index].data, sizeof(float) * g_external[index].len);
                bn->n.table_len = g_external[index].len;
                bn->n.box_rate = box ? json_number(json_get(box, "sampleRate"), 0) : 0;
            }
            box = NULL;
        }
        if (box) {
            const json_value *samples = json_get(box, "samples");
            if (samples && samples->type == JSON_ARRAY && samples->count > 0) {
                src = samples;
                rate = json_number(json_get(box, "sampleRate"), 0);
            }
        }
        if (!src && !bn->table) {
            const json_value *table = json_get(p, "table");
            if (table && table->type == JSON_ARRAY && table->count > 0) src = table;
        }
        if (src) {
            int ok = 1;
            for (int i = 0; i < src->count; i++) if (!json_is_number(&src->items[i])) ok = 0;
            if (ok) {
                bn->table = (float *)malloc(sizeof(float) * (size_t)src->count);
                for (int i = 0; i < src->count; i++) bn->table[i] = (float)json_number(&src->items[i], 0);
                bn->n.table_len = (uint32_t)src->count;
                bn->n.box_rate = rate;
            }
        }
    }

    int a_len = 0, b_len = 0;
    switch (kind) {
    case CK_WAVESHAPE: {
        bn->a = numbers(json_get(p, "curve"), &a_len);
        if (!bn->a) { static const double d[3] = { -1, 0, 1 }; bn->a = literal(d, 3, &a_len); }
        break;
    }
    case CK_BREAKPOINTS: {
        bn->a = numbers(json_get(p, "times"), &a_len);
        if (!bn->a) { static const double d[2] = { 0, 1 }; bn->a = literal(d, 2, &a_len); }
        bn->b = numbers(json_get(p, "levels"), &b_len);
        if (!bn->b) { static const double d[2] = { 0, 1 }; bn->b = literal(d, 2, &b_len); }
        break;
    }
    case CK_TRANSPORT:
        bn->a = numbers(json_get(p, "divisions"), &a_len);
        break;
    case CK_ADSR: {
        double v[4] = {
            json_number(json_get(p, "a"), 0), json_number(json_get(p, "d"), 0),
            json_number(json_get(p, "s"), 0), json_number(json_get(p, "r"), 0),
        };
        bn->a = literal(v, 4, &a_len);
        break;
    }
    default: break;
    }
    if (a_len > 0xFFFF || b_len > 0xFFFF) { berror(b, "%s", "a curve is longer than a plan can hold"); return -1; }
    bn->n.a_len = (uint16_t)a_len;
    bn->n.b_len = (uint16_t)b_len;

    /* A `range` bound that is not a finite number is refused, as compile.ts. */
    if (kind == CK_RANGE) {
        const json_value *lo = json_get(p, "min"), *hi = json_get(p, "max");
        if (!json_is_number(lo) || !json_is_number(hi) || !isfinite(json_number(lo, 0)) || !isfinite(json_number(hi, 0))) {
            berror(b, "%s", "ASL range node: min and max must be finite numbers");
            return -1;
        }
        bn->n.range_min = json_number(lo, 0);
        bn->n.range_max = json_number(hi, 0);
    }

    /* Registered before the children are visited, so a document that refers
     * back to itself terminates instead of recursing. */
    idmap_put(&b->planned, id, (void *)(intptr_t)(slot + 1));

    switch (kind) {
    case CK_LANE: b->uses_lane = 1; break;
    case CK_PORT:
        strset_add(&b->ports, b->nodes[slot].name);
        if (json_is_number(json_get(p, "channel"))) b->uses_lane = 1;
        break;
    case CK_PARAM:
        strset_add(&b->params, b->nodes[slot].name);
        if (strcmp(b->nodes[slot].name, "input") == 0) b->reads_scalar_input = 1;
        break;
    case CK_METER:
    case CK_CAPTURE: {
        int before = b->taps.count;
        int at = strset_add(&b->taps, b->nodes[slot].name);
        if (b->taps.count != before) {
            b->tap_windows = (int *)realloc(b->tap_windows, sizeof(int) * (size_t)b->taps.count);
            b->tap_windows[at] = 0;
        }
        if (kind == CK_CAPTURE && (int)b->nodes[slot].n.c > b->tap_windows[at]) b->tap_windows[at] = (int)b->nodes[slot].n.c;
        break;
    }
    case CK_NOISE:
    case CK_RANDOM: b->uses_random = 1; break;
    default: break;
    }

    const json_value *inputs = json_get(doc, "inputs");
    if (inputs && inputs->type == JSON_OBJECT) {
        for (int i = 0; i < inputs->count; i++) {
            int input = input_from_name(inputs->keys[i]);
            if (input < 0) { berror(b, "unknown ASL input name \"%s\"", inputs->keys[i]); return -1; }
            int child = visit(b, &inputs->items[i]);
            if (child < 0) return -1;
            b->nodes[slot].n.in[input] = (int16_t)child;
        }
    }
    const json_value *list = json_get(doc, "list");
    if (list && list->type == JSON_ARRAY && list->count > 0) {
        int *planned = (int *)malloc(sizeof(int) * (size_t)list->count);
        for (int i = 0; i < list->count; i++) {
            planned[i] = visit(b, &list->items[i]);
            if (planned[i] < 0) { free(planned); return -1; }
        }
        b->nodes[slot].list = planned;
        b->nodes[slot].n.list_count = (uint16_t)list->count;
    }
    return slot;
}

/* `randomRanks`: first visit in a depth-first walk from the output, inputs
 * in sorted name order, a `mix` list in order. The graph's shape is the one
 * thing every implementation agrees on. */
typedef struct rank_walk {
    builder *b;
    idmap seen;
    int next;
} rank_walk;

static void rank_visit(rank_walk *w, const json_value *raw) {
    const json_value *doc = resolve(w->b, raw);
    if (!doc) return;
    long long id = (long long)json_number(json_get(doc, "id"), 0);
    if (idmap_get(&w->seen, id)) return;
    idmap_put(&w->seen, id, (void *)1);
    const char *kind = json_string(json_get(doc, "kind"), "");
    if (strcmp(kind, "noise") == 0 || strcmp(kind, "random") == 0) {
        void *slot = idmap_get(&w->b->planned, id);
        if (slot) w->b->nodes[(intptr_t)slot - 1].n.ix = (uint16_t)w->next;
        w->next++;
    }
    const json_value *inputs = json_get(doc, "inputs");
    if (inputs && inputs->type == JSON_OBJECT && inputs->count > 0) {
        int *order = (int *)malloc(sizeof(int) * (size_t)inputs->count);
        for (int i = 0; i < inputs->count; i++) order[i] = i;
        for (int i = 1; i < inputs->count; i++) {
            int v = order[i], j = i - 1;
            while (j >= 0 && strcmp(inputs->keys[order[j]], inputs->keys[v]) > 0) { order[j + 1] = order[j]; j--; }
            order[j + 1] = v;
        }
        for (int i = 0; i < inputs->count; i++) rank_visit(w, &inputs->items[order[i]]);
        free(order);
    }
    const json_value *list = json_get(doc, "list");
    if (list && list->type == JSON_ARRAY) {
        for (int i = 0; i < list->count; i++) rank_visit(w, &list->items[i]);
    }
}

/* ---------------------------------------------------------------------------
 * Serialisation
 * ------------------------------------------------------------------------ */

typedef struct bytes {
    uint8_t *data;
    size_t len, cap;
} bytes;

static size_t bytes_reserve(bytes *o, size_t n, size_t align) {
    size_t at = (o->len + align - 1) & ~(align - 1);
    if (at + n > o->cap) {
        while (at + n > o->cap) o->cap = o->cap ? o->cap * 2 : 4096;
        o->data = (uint8_t *)realloc(o->data, o->cap);
    }
    memset(o->data + o->len, 0, at + n - o->len);
    o->len = at + n;
    return at;
}

static size_t bytes_put(bytes *o, const void *src, size_t n, size_t align) {
    size_t at = bytes_reserve(o, n, align);
    if (n) memcpy(o->data + at, src, n);
    return at;
}

static void free_builder(builder *b) {
    for (int i = 0; i < b->count; i++) {
        free(b->nodes[i].name);
        free(b->nodes[i].a);
        free(b->nodes[i].b);
        free(b->nodes[i].table);
        free(b->nodes[i].list);
    }
    free(b->nodes);
    idmap_free(&b->planned);
    idmap_free(&b->defined);
    strset_free(&b->params);
    strset_free(&b->ports);
    strset_free(&b->taps);
    free(b->tap_windows);
}

void *crate_build_plan(const json_value *graph, size_t *size, char *error, size_t error_size) {
    if (error && error_size) error[0] = 0;
    const json_value *output = json_get(graph, "output");
    if (!output) {
        if (error) snprintf(error, error_size, "graph has no output");
        return NULL;
    }
    builder b;
    memset(&b, 0, sizeof b);
    b.error = error;
    b.error_size = error_size;
    idmap_init(&b.planned, 256);
    idmap_init(&b.defined, 256);
    collect_defined(&b, output);

    int root = visit(&b, output);
    if (root < 0 || b.failed) {
        free_builder(&b);
        return NULL;
    }
    if (b.uses_random) {
        rank_walk w;
        w.b = &b;
        w.next = 0;
        idmap_init(&w.seen, b.count);
        rank_visit(&w, output);
        idmap_free(&w.seen);
    }

    /* Names sorted, then each node pointed at its index in the sorted list. */
    strset_sort(&b.params);
    strset_sort(&b.ports);
    /* Taps are sorted too, carrying their windows with them. */
    int *windows = (int *)calloc((size_t)(b.taps.count ? b.taps.count : 1), sizeof(int));
    {
        strset unsorted = { NULL, 0, 0 };
        for (int i = 0; i < b.taps.count; i++) strset_add(&unsorted, b.taps.items[i]);
        strset_sort(&b.taps);
        for (int i = 0; i < b.taps.count; i++) windows[i] = b.tap_windows[strset_find(&unsorted, b.taps.items[i])];
        strset_free(&unsorted);
    }
    for (int i = 0; i < b.count; i++) {
        bnode *bn = &b.nodes[i];
        if (bn->n.kind == CK_PARAM) bn->n.ix = (uint16_t)strset_find(&b.params, bn->name);
        if (bn->n.kind == CK_PORT) bn->n.ix = (uint16_t)strset_find(&b.ports, bn->name);
        if (bn->n.kind == CK_METER || bn->n.kind == CK_CAPTURE) bn->n.ix = (uint16_t)strset_find(&b.taps, bn->name);
    }

    /* Sends: nodes inside `output`, by id. */
    const json_value *sends = json_get(graph, "sends");
    int send_count = sends && sends->type == JSON_ARRAY ? sends->count : 0;
    uint16_t *send_slots = (uint16_t *)calloc((size_t)(send_count ? send_count : 1), sizeof(uint16_t));
    for (int k = 0; k < send_count; k++) {
        const json_value *send = &sends->items[k];
        const json_value *idv = json_get(send, "id");
        if (!idv) idv = json_get(send, "ref");
        void *slot = idmap_get(&b.planned, (long long)json_number(idv, 0));
        if (!slot) {
            if (error) snprintf(error, error_size, "a send is not reachable from the graph output");
            free(send_slots);
            free(windows);
            free_builder(&b);
            return NULL;
        }
        send_slots[k] = (uint16_t)((intptr_t)slot - 1);
    }

    /* Smoothed params, as indices; a name the graph never reads is dropped. */
    const json_value *smooth = json_get(graph, "smooth");
    int smooth_count = 0;
    uint16_t *smooth_ix = (uint16_t *)calloc((size_t)(smooth && smooth->type == JSON_ARRAY && smooth->count ? smooth->count : 1), sizeof(uint16_t));
    if (smooth && smooth->type == JSON_ARRAY) {
        for (int k = 0; k < smooth->count; k++) {
            int ix = strset_find(&b.params, json_string(&smooth->items[k], ""));
            if (ix >= 0) smooth_ix[smooth_count++] = (uint16_t)ix;
        }
    }

    /* The bus, built on its own and appended. */
    void *bus_blob = NULL;
    size_t bus_size = 0;
    const json_value *bus = json_get(graph, "bus");
    if (bus && bus->type == JSON_OBJECT) {
        bus_blob = crate_build_plan(bus, &bus_size, error, error_size);
        if (!bus_blob) {
            free(send_slots);
            free(smooth_ix);
            free(windows);
            free_builder(&b);
            return NULL;
        }
    }

    bytes o = { NULL, 0, 0 };
    crate_plan_header h;
    memset(&h, 0, sizeof h);
    bytes_reserve(&o, sizeof h, 8);

    /* Pools first, so each node can be given its offsets. */
    bytes idx = { NULL, 0, 0 }, num = { NULL, 0, 0 }, tab = { NULL, 0, 0 }, str = { NULL, 0, 0 };
    bytes_reserve(&str, 1, 1); /* offset 0 is the empty string */
    crate_node *nodes = (crate_node *)calloc((size_t)b.count, sizeof(crate_node));
    for (int i = 0; i < b.count; i++) {
        bnode *bn = &b.nodes[i];
        nodes[i] = bn->n;
        if (bn->n.list_count) {
            size_t at = bytes_reserve(&idx, sizeof(int16_t) * bn->n.list_count, 2);
            int16_t *dst = (int16_t *)(idx.data + at);
            for (int k = 0; k < bn->n.list_count; k++) dst[k] = (int16_t)bn->list[k];
            nodes[i].list_off = (uint32_t)(at / 2);
        }
        if (bn->n.a_len) nodes[i].a_off = (uint32_t)(bytes_put(&num, bn->a, sizeof(double) * bn->n.a_len, 8) / 8);
        if (bn->n.b_len) nodes[i].b_off = (uint32_t)(bytes_put(&num, bn->b, sizeof(double) * bn->n.b_len, 8) / 8);
        if (bn->n.table_len) nodes[i].table_off = (uint32_t)(bytes_put(&tab, bn->table, sizeof(float) * bn->n.table_len, 4) / 4);
    }
    uint32_t *param_offs = (uint32_t *)calloc((size_t)(b.params.count + 1), 4);
    uint32_t *port_offs = (uint32_t *)calloc((size_t)(b.ports.count + 1), 4);
    uint32_t *tap_offs = (uint32_t *)calloc((size_t)(b.taps.count + 1), 4);
    uint32_t *tap_win = (uint32_t *)calloc((size_t)(b.taps.count + 1), 4);
    for (int i = 0; i < b.params.count; i++) param_offs[i] = (uint32_t)bytes_put(&str, b.params.items[i], strlen(b.params.items[i]) + 1, 1);
    for (int i = 0; i < b.ports.count; i++) port_offs[i] = (uint32_t)bytes_put(&str, b.ports.items[i], strlen(b.ports.items[i]) + 1, 1);
    for (int i = 0; i < b.taps.count; i++) {
        tap_offs[i] = (uint32_t)bytes_put(&str, b.taps.items[i], strlen(b.taps.items[i]) + 1, 1);
        tap_win[i] = (uint32_t)windows[i];
    }

    h.magic = CRATE_PLAN_MAGIC;
    h.version = CRATE_PLAN_VERSION;
    h.node_count = (uint16_t)b.count;
    h.root = (uint16_t)root;
    {
        const json_value *ch = json_get(graph, "channels");
        int channels = json_is_number(ch) ? (int)json_number(ch, 0) : 0;
        h.channels = (int8_t)(channels == 1 || channels == 2 ? channels : 0);
    }
    h.flags = (uint8_t)((b.uses_lane ? CRATE_PF_USES_LANE : 0) | (b.uses_random ? CRATE_PF_USES_RANDOM : 0) |
                        (b.reads_scalar_input ? CRATE_PF_READS_SCALAR_INPUT : 0));
    h.param_count = (uint16_t)b.params.count;
    h.port_count = (uint16_t)b.ports.count;
    h.tap_count = (uint16_t)b.taps.count;
    h.send_count = (uint16_t)send_count;
    h.smooth_count = (uint16_t)smooth_count;
    {
        int main_port = strset_find(&b.ports, "input");
        h.main_port = main_port < 0 ? CRATE_NONE : (uint16_t)main_port;
    }

    h.nodes_off = (uint32_t)bytes_put(&o, nodes, sizeof(crate_node) * (size_t)b.count, 8);
    h.index_off = (uint32_t)bytes_put(&o, idx.data, idx.len, 8);
    h.number_off = (uint32_t)bytes_put(&o, num.data, num.len, 8);
    h.table_off = (uint32_t)bytes_put(&o, tab.data, tab.len, 8);
    h.string_off = (uint32_t)bytes_put(&o, str.data, str.len, 8);
    h.params_off = (uint32_t)bytes_put(&o, param_offs, 4 * (size_t)b.params.count, 8);
    h.ports_off = (uint32_t)bytes_put(&o, port_offs, 4 * (size_t)b.ports.count, 8);
    h.taps_off = (uint32_t)bytes_put(&o, tap_offs, 4 * (size_t)b.taps.count, 8);
    h.tap_windows_off = (uint32_t)bytes_put(&o, tap_win, 4 * (size_t)b.taps.count, 8);
    h.sends_off = (uint32_t)bytes_put(&o, send_slots, 2 * (size_t)send_count, 8);
    h.smooth_off = (uint32_t)bytes_put(&o, smooth_ix, 2 * (size_t)smooth_count, 8);
    if (bus_blob) h.bus_off = (uint32_t)bytes_put(&o, bus_blob, bus_size, 8);
    bytes_reserve(&o, 0, 8);
    h.size = (uint32_t)o.len;
    memcpy(o.data, &h, sizeof h);

    free(nodes);
    free(idx.data);
    free(num.data);
    free(tab.data);
    free(str.data);
    free(param_offs);
    free(port_offs);
    free(tap_offs);
    free(tap_win);
    free(send_slots);
    free(smooth_ix);
    free(windows);
    free(bus_blob);
    free_builder(&b);
    *size = o.len;
    return o.data;
}
