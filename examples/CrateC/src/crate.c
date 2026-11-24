/*
 * The interpreter. Read it next to `examples/CrateASL/Sources/CrateASL`:
 * the evaluators below are `Nodes.swift` and `NodeHelpers.swift` case for
 * case, in the same order, because the Swift port already holds the
 * JavaScript reference to zero deviation and two places to be different is
 * one more than this needs. Where a comment restates one from there, the
 * reason is the same reason.
 *
 * Deliberately absent, for now:
 *
 *   - bound kernels. A seam passes its input through and a source kernel
 *     takes its declared fallback, which is the unbound contract the
 *     conformance fixture pins. No factory patch binds one.
 *   - the per-frame schedule (`Schedule.swift`). It is a speed-up that
 *     computes the same values in a different order; the value cache makes
 *     order unobservable, so the plain recursive walk is the same audio.
 *   - a split instrument rendering its own bus as one voice. A voice pool
 *     runs the bus (`crate_pool.c`), which is the only host that needs it.
 */
#include "crate.h"

#include <math.h>
#include <string.h>

#ifdef CRATE_REAL_FLOAT
#define R(x) x##f
#define RL(x) ((float)(x))
#else
#define R(x) x
#define RL(x) (x)
#endif

#define PI_R RL(3.14159265358979323846)

const char *const crate_kind_names[CK_COUNT] = {
    "const", "param", "port", "lane", "meter", "capture",
    "osc", "lfo", "adsr", "mix", "mul", "add", "toFrequency", "range",
    "filterLowpass", "filterHighpass", "filterBandpass", "filterNotch",
    "filterPeaking", "filterLowShelf", "filterHighShelf", "filterAllpass",
    "onePoleLowpass", "onePoleHighpass", "svf", "ladder", "comb",
    "bitcrush", "downsample", "rectify", "slew", "sampleHold", "compare", "compressor",
    "clock", "clockDivide", "clockMultiply", "logic", "flipFlop", "quantize",
    "euclidean", "random", "trigger", "pulse", "dahdsr", "sequencer", "impulse",
    "expander", "transient", "reverse", "looper", "select", "waveshape", "breakpoints",
    "rms", "peak", "onset", "pitch", "filterSlope", "wavetable", "samplePlay", "grain",
    "pitchShift", "panLaw", "noise", "delay", "clip", "dcBlock", "envFollow",
    "transport", "kernel",
};

const char *const crate_input_names[CI_COUNT] = {
    "input", "a", "b", "attack", "bits", "clock", "cutoff", "decay", "delay", "drive",
    "duration", "factor", "fall", "feedback", "freq", "gainDb", "gate", "hits", "hold",
    "index", "length", "mix", "note", "pan", "phase", "pitch", "position", "q", "rate",
    "ratio", "record", "release", "reset", "resonance", "rise", "root", "rotation",
    "scale", "sidechain", "source", "steps", "sustain", "threshold", "timeSec", "trig",
    "trigger", "which", "width", "widthSec", "windowSec", "type", "color",
};

/* ---------------------------------------------------------------------------
 * Numerics, matched to the reference
 * ------------------------------------------------------------------------ */

/* Swift's `min` and `max`, which are what the Swift port calls and which
 * decide NaN the same way: `y < x ? y : x` and `y >= x ? y : x`. */
static inline crate_real rmin(crate_real x, crate_real y) { return y < x ? y : x; }
static inline crate_real rmax(crate_real x, crate_real y) { return y >= x ? y : x; }
static inline int imin(int x, int y) { return y < x ? y : x; }
static inline int imax(int x, int y) { return y >= x ? y : x; }

/* JavaScript's `Math.round`, which rounds a half toward positive infinity. */
static inline crate_real js_round(crate_real x) { return R(floor)(x + RL(0.5)); }

/* JavaScript's `%`, which keeps the sign of the dividend. */
static inline crate_real js_mod(crate_real x, crate_real m) { return R(fmod)(x, m); }

/* `jsMod` without `fmod` on the paths a phase or a ring index takes every
 * sample. Bit-identical: inside (-m, m) the remainder is x, and on [m, 2m)
 * `x - m` is exact. */
static inline crate_real wrap_mod(crate_real x, crate_real m) {
    if (x > -m && x < m) return x;
    if (x >= m && x < 2 * m) return x - m;
    return js_mod(x, m);
}

/* `jsMod(jsMod(x, m) + m, m)`, the always-positive wrap a ring reads through. */
static inline crate_real js_wrap(crate_real x, crate_real m) {
    if (x >= 0 && x < m) {
        crate_real t = x + m;
        return t < 2 * m ? t - m : js_mod(t, m);
    }
    if (x < 0 && x > -m) {
        crate_real t = x + m;
        return t < m ? t : js_mod(t, m);
    }
    return js_mod(js_mod(x, m) + m, m);
}

/* Oscillator shapes, resolved from their strings when the plan is built. */
enum { SH_SINE, SH_SAW, SH_SQUARE, SH_TRIANGLE, SH_PULSE, SH_VARSHAPE, SH_SUPERSQUARE, SH_HARMONIC };

static crate_real oscillator_sample(int shape, crate_real phase, crate_real width, crate_real freq, crate_real sr) {
    switch (shape) {
    case SH_SAW: return 2 * phase - 1;
    case SH_SQUARE: return phase < RL(0.5) ? 1 : -1;
    case SH_TRIANGLE: return phase < RL(0.5) ? 4 * phase - 1 : 3 - 4 * phase;
    case SH_PULSE: {
        crate_real duty = rmin(rmax(width, RL(1e-4)), 1 - RL(1e-4));
        return phase < duty ? 1 : -1;
    }
    case SH_VARSHAPE: {
        crate_real t = rmin(rmax(width, 0), 1);
        crate_real tri = phase < RL(0.5) ? 4 * phase - 1 : 3 - 4 * phase;
        crate_real saw = 2 * phase - 1;
        crate_real square = phase < RL(0.5) ? RL(1.0) : RL(-1.0);
        if (t < RL(0.5)) {
            crate_real mix = t * 2;
            return tri * (1 - mix) + saw * mix;
        }
        crate_real mix = (t - RL(0.5)) * 2;
        return saw * (1 - mix) + square * mix;
    }
    case SH_HARMONIC: {
        crate_real freq_norm = freq / sr;
        int max_harm = imin(16, (int)R(floor)(RL(0.5) / rmax(freq_norm, RL(1e-9))));
        if (max_harm < 1) max_harm = 1;
        crate_real tilt = rmin(rmax(width, 0), 1);
        crate_real exponent = 2 * (1 - tilt);
        crate_real norm = 0, sample = 0;
        for (int h = 0; h < max_harm; h++) {
            crate_real n = (crate_real)(h + 1);
            crate_real amp = 1 / R(pow)(n, exponent);
            norm += amp;
            crate_real harm_phase = phase * n;
            sample += amp * R(sin)(2 * PI_R * (harm_phase - R(floor)(harm_phase)));
        }
        return norm > 0 ? sample / norm : 0;
    }
    default: return R(sin)(2 * PI_R * phase);
    }
}

/* ---------------------------------------------------------------------------
 * Seeded randomness: `asl/rng.ts` and `Rng.swift`, exactly
 * ------------------------------------------------------------------------ */

static uint32_t stream_seed(uint32_t voice_seed, int rank, int lane) {
    uint32_t h = voice_seed ^ ((uint32_t)(rank + 1) * 0x9e3779b1u) ^ ((uint32_t)(lane + 1) * 0x85ebca6bu);
    h = (h ^ (h >> 16)) * 0x85ebca6bu;
    h = (h ^ (h >> 13)) * 0xc2b2ae35u;
    return h ^ (h >> 16);
}

/* mulberry32. The draw is an integer over 2^32, exact in a double; in a
 * float build it is rounded once, here. */
static crate_real next_uniform(uint32_t *state) {
    uint32_t s = *state + 0x6d2b79f5u;
    *state = s;
    uint32_t t = (s ^ (s >> 15)) * (s | 1u);
    t ^= t + ((t ^ (t >> 7)) * (t | 61u));
    return (crate_real)((double)(t ^ (t >> 14)) / 4294967296.0);
}

int crate_param_ramp_frames(double sample_rate) {
    int frames = (int)round(CRATE_PARAM_RAMP_SECONDS * sample_rate);
    return frames < 1 ? 1 : frames;
}

/* ---------------------------------------------------------------------------
 * Plan
 * ------------------------------------------------------------------------ */

static int in_range(uint32_t off, size_t bytes, size_t size) {
    return (size_t)off <= size && bytes <= size - (size_t)off;
}

int crate_plan_open(crate_plan *plan, const void *blob, size_t size) {
    memset(plan, 0, sizeof *plan);
    if (!blob || size < sizeof(crate_plan_header)) return -1;
    const uint8_t *base = (const uint8_t *)blob;
    const crate_plan_header *h = (const crate_plan_header *)blob;
    if (h->magic != CRATE_PLAN_MAGIC || h->version != CRATE_PLAN_VERSION) return -1;
    if (h->size > size || h->node_count == 0 || h->root >= h->node_count) return -1;
    size = h->size;
    if (!in_range(h->nodes_off, (size_t)h->node_count * sizeof(crate_node), size)) return -1;
    if (!in_range(h->params_off, (size_t)h->param_count * 4, size)) return -1;
    if (!in_range(h->ports_off, (size_t)h->port_count * 4, size)) return -1;
    if (!in_range(h->taps_off, (size_t)h->tap_count * 4, size)) return -1;
    if (!in_range(h->tap_windows_off, (size_t)h->tap_count * 4, size)) return -1;
    if (!in_range(h->sends_off, (size_t)h->send_count * 2, size)) return -1;
    if (!in_range(h->smooth_off, (size_t)h->smooth_count * 2, size)) return -1;
    if (h->string_off > size || h->index_off > size || h->number_off > size || h->table_off > size) return -1;

    plan->h = h;
    plan->nodes = (const crate_node *)(base + h->nodes_off);
    plan->index = (const int16_t *)(base + h->index_off);
    plan->numbers = (const double *)(base + h->number_off);
    plan->tables = (const float *)(base + h->table_off);
    plan->strings = (const char *)(base + h->string_off);
    plan->params = (const uint32_t *)(base + h->params_off);
    plan->ports = (const uint32_t *)(base + h->ports_off);
    plan->taps = (const uint32_t *)(base + h->taps_off);
    plan->tap_windows = (const uint32_t *)(base + h->tap_windows_off);
    plan->sends = (const uint16_t *)(base + h->sends_off);
    plan->smooth = (const uint16_t *)(base + h->smooth_off);
    plan->bus_blob = h->bus_off ? (const void *)(base + h->bus_off) : NULL;

    /* Every child index is a node, or nothing. A blob that names a node it
     * does not have is refused here, once, rather than trusted per sample. */
    for (int i = 0; i < h->node_count; i++) {
        const crate_node *n = &plan->nodes[i];
        if (n->kind >= CK_COUNT) return -1;
        for (int k = 0; k < CI_COUNT; k++) {
            if (n->in[k] >= (int)h->node_count) return -1;
        }
        if (n->list_count) {
            if (!in_range(h->index_off + n->list_off * 2u, (size_t)n->list_count * 2, size)) return -1;
            for (int k = 0; k < n->list_count; k++) {
                int16_t c = plan->index[n->list_off + (uint32_t)k];
                if (c < 0 || c >= (int)h->node_count) return -1;
            }
        }
    }
    for (int k = 0; k < h->send_count; k++) {
        if (plan->sends[k] >= h->node_count) return -1;
    }

    if (h->channels == 1) plan->stereo = 0;
    else if (h->channels == 2) plan->stereo = 1;
    else plan->stereo = h->port_count > 0 || (h->flags & CRATE_PF_USES_LANE);
    /* A stereo graph handed the same samples on both sides, from state that
     * started identical, computes the same block twice, unless it asks which
     * channel it is on or draws random numbers. */
    plan->mirrors_mono_input = plan->stereo && !(h->flags & CRATE_PF_USES_LANE) && !(h->flags & CRATE_PF_USES_RANDOM);
    plan->main_port = h->main_port == CRATE_NONE ? -1 : (int)h->main_port;
    return 0;
}

const char *crate_plan_param_name(const crate_plan *plan, int index) {
    if (index < 0 || index >= plan->h->param_count) return NULL;
    return plan->strings + plan->params[index];
}

const char *crate_plan_port_name(const crate_plan *plan, int index) {
    if (index < 0 || index >= plan->h->port_count) return NULL;
    return plan->strings + plan->ports[index];
}

int crate_plan_param_index(const crate_plan *plan, const char *name) {
    for (int i = 0; i < plan->h->param_count; i++) {
        if (strcmp(plan->strings + plan->params[i], name) == 0) return i;
    }
    return -1;
}

int crate_plan_port_index(const crate_plan *plan, const char *name) {
    for (int i = 0; i < plan->h->port_count; i++) {
        if (strcmp(plan->strings + plan->ports[i], name) == 0) return i;
    }
    return -1;
}

/* ---------------------------------------------------------------------------
 * Arena
 * ------------------------------------------------------------------------ */

void crate_arena_init(crate_arena *arena, void *memory, size_t bytes) {
    arena->base = (uint8_t *)memory;
    arena->cap = bytes;
    arena->used = 0;
}

void *crate_arena_alloc(crate_arena *arena, size_t bytes) {
    size_t at = (arena->used + 7u) & ~(size_t)7u;
    if (!arena->base || at > arena->cap || bytes > arena->cap - at) return NULL;
    arena->used = at + bytes;
    void *p = arena->base + at;
    memset(p, 0, bytes);
    return p;
}

/* ---------------------------------------------------------------------------
 * Node memory
 *
 * One struct holding the union of every kind's fields, as `NodeMemory` in
 * State.swift. Delay lines, a euclidean pattern and the grain list are taken
 * separately, so a node that has none of them pays nothing for them.
 * ------------------------------------------------------------------------ */

enum { ST_IDLE, ST_DELAY, ST_ATTACK, ST_HOLD, ST_DECAY, ST_SUSTAIN, ST_RELEASE };

typedef struct crate_grain {
    crate_real pos, i, n, rate;
} crate_grain;

/*
 * What an audio ring stores.
 *
 * Float by default, because the reference's lines are `Float32Array` and a
 * delay line's quantisation is part of its sound. CRATE_LINE_INT16 halves
 * the memory for a target that cannot afford a float second of delay, at a
 * fixed scale with headroom to +-4 (about -88 dBFS of quantisation noise),
 * because feedback builds a line above full scale and a line that clipped
 * at 1 would distort exactly the echoes it exists to hold. Saturates rather
 * than wraps past that.
 */
#ifdef CRATE_LINE_INT16
typedef int16_t crate_line;
#define CRATE_LINE_SCALE 8192.0f
static inline crate_line line_store(crate_real v) {
    float x = (float)v * CRATE_LINE_SCALE;
    if (!(x > -32767.0f)) x = -32767.0f; /* NaN lands here too */
    if (x > 32767.0f) x = 32767.0f;
    return (crate_line)(x < 0 ? x - 0.5f : x + 0.5f);
}
#define LINE_GET(m, i) ((crate_real)(m)->line[(i)] * (crate_real)(1.0f / CRATE_LINE_SCALE))
#define LINE_SET(m, i, v) ((m)->line[(i)] = line_store((crate_real)(v)))
#else
typedef float crate_line;
#define LINE_GET(m, i) ((crate_real)(m)->line[(i)])
#define LINE_SET(m, i, v) ((m)->line[(i)] = (float)(v))
#endif

#define CRATE_MAX_GRAINS 8
#define CRATE_MAX_EUCLID_STEPS 256

struct crate_mem {
    crate_real phase;
    crate_real x1, x2, y1, y2;
    crate_real n0, n1, n2, d1, d2;
    crate_real k0, k1, k2, k3, c0, c1;
    crate_real level, peak, stage_elapsed, stage_start_level;
    crate_real env, ka, ca, kr, cr;
    crate_real prev, prev_reset, held, count, index, on;
    crate_real s0, s1, s2, s3;
    crate_real since, interval, next_at, left;
    crate_real sum, filled, pos;
    /* `line` for the audio rings (delay, comb, reverse, looper, pitch
     * shift), `buf` for the analysis ones (rms squares, the pitch detector's
     * window). Only one is ever taken; `buf_len` is its length. */
    crate_line *line;
    float *buf;
    int32_t buf_len, write_idx, read_idx, length;
    uint8_t *pattern;
    int32_t pattern_len;
    crate_grain *grains;
    int32_t grain_count;
    uint32_t rng;
    uint8_t stage, last_gate, prev_gate, armed, playing, initialized, buf_failed;
};

static void mem_reset(crate_mem *m) {
    memset(m, 0, sizeof *m);
    m->k0 = m->k1 = m->k2 = m->k3 = (crate_real)NAN;
    m->ka = m->kr = (crate_real)NAN;
    m->index = -1;
}

static crate_mem *memory_for(crate_state *s, int slot) {
    crate_mem **store = s->mem[s->lane > 0 ? 1 : 0];
    if (!store) {
        /* A second channel's table, taken the first time it is rendered. */
        int count = s->plan->h->node_count;
        store = (crate_mem **)crate_arena_alloc(s->arena, sizeof(crate_mem *) * (size_t)count);
        if (!store) { s->starved = 1; return NULL; }
        s->mem[s->lane > 0 ? 1 : 0] = store;
    }
    if (store[slot]) return store[slot];
    crate_mem *fresh = (crate_mem *)crate_arena_alloc(s->arena, sizeof(crate_mem));
    if (!fresh) { s->starved = 1; return NULL; }
    mem_reset(fresh);
    store[slot] = fresh;
    return fresh;
}

/* A ring buffer, taken once. Fails at most once per node: a node that could
 * not get its line stops asking, rather than retrying every sample. */
static int ensure_buf(crate_state *s, crate_mem *m, int32_t len) {
    if (m->buf) return 1;
    if (m->buf_failed) return 0;
    m->buf = (float *)crate_arena_alloc(s->arena, sizeof(float) * (size_t)len);
    if (!m->buf) { m->buf_failed = 1; s->starved = 1; return 0; }
    m->buf_len = len;
    return 1;
}

static int ensure_line(crate_state *s, crate_mem *m, int32_t len) {
    if (m->line) return 1;
    if (m->buf_failed) return 0;
    m->line = (crate_line *)crate_arena_alloc(s->arena, sizeof(crate_line) * (size_t)len);
    if (!m->line) { m->buf_failed = 1; s->starved = 1; return 0; }
    m->buf_len = len;
    return 1;
}

/* ---------------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------------ */

void crate_transport_default(crate_transport *t) {
    t->beats = 0;
    t->bpm = 120;
    t->playing = 0;
    t->beats_per_bar = 4;
    t->beat_unit = 4;
}

#define ALLOC_ARRAY(arena, type, count) ((type *)crate_arena_alloc((arena), sizeof(type) * (size_t)((count) > 0 ? (count) : 1)))

int crate_state_init(crate_state *s, const crate_plan *plan, crate_arena *arena, uint32_t seed) {
    memset(s, 0, sizeof *s);
    const crate_plan_header *h = plan->h;
    s->plan = plan;
    s->arena = arena;
    s->seed = seed;
    s->generation = 1;
    s->values = ALLOC_ARRAY(arena, crate_real, h->node_count);
    s->stamps = ALLOC_ARRAY(arena, uint32_t, h->node_count);
    s->mem[0] = ALLOC_ARRAY(arena, crate_mem *, h->node_count);
    s->param_values = ALLOC_ARRAY(arena, crate_real, h->param_count);
    s->ramp_step = ALLOC_ARRAY(arena, crate_real, h->param_count);
    s->ramp_target = ALLOC_ARRAY(arena, crate_real, h->param_count);
    s->ramp_frames = ALLOC_ARRAY(arena, int32_t, h->param_count);
    s->param_set = ALLOC_ARRAY(arena, uint8_t, h->param_count);
    s->port_scalars = ALLOC_ARRAY(arena, crate_real, h->port_count);
    s->port_l = ALLOC_ARRAY(arena, const float *, h->port_count);
    s->port_r = ALLOC_ARRAY(arena, const float *, h->port_count);
    s->tap_peak = ALLOC_ARRAY(arena, crate_real, h->tap_count);
    s->tap_sum_sq = ALLOC_ARRAY(arena, crate_real, h->tap_count);
    s->tap_count = ALLOC_ARRAY(arena, crate_real, h->tap_count);
    crate_transport_default(&s->transport);
    if (!s->values || !s->stamps || !s->mem[0] || !s->param_values || !s->ramp_step || !s->ramp_target ||
        !s->ramp_frames || !s->param_set || !s->port_scalars || !s->port_l || !s->port_r ||
        !s->tap_peak || !s->tap_sum_sq || !s->tap_count) {
        return -1;
    }
    return 0;
}

/* The fixed size of a node's ring, or 0 when it has none or its size is a
 * graph input (`rms`), which only a render can know. */
static int32_t fixed_buffer_len(const crate_node *n, crate_real sr) {
    switch (n->kind) {
    case CK_DELAY: {
        crate_real max_time = rmax((crate_real)n->c, 1 / sr);
        return (int32_t)rmax(2, R(ceil)(max_time * sr) + 2);
    }
    case CK_COMB: return (int32_t)rmax(2, R(ceil)(sr / 20) + 2);
    case CK_REVERSE:
    case CK_LOOPER: {
        crate_real max_time = rmax((crate_real)n->c, 1 / sr);
        return (int32_t)rmax(2, R(ceil)(max_time * sr));
    }
    case CK_PITCH: return 1024;
    case CK_PITCH_SHIFT: return (int32_t)(rmax(32, js_round(RL(0.04) * sr)) * 4);
    default: return 0;
    }
}

int crate_state_prepare(crate_state *s, double sample_rate) {
    return crate_state_prepare_lanes(s, sample_rate, s->plan->stereo ? 2 : 1);
}

int crate_state_prepare_lanes(crate_state *s, double sample_rate, int lanes) {
    const crate_plan_header *h = s->plan->h;
    if (lanes < 1) lanes = 1;
    if (lanes > 2) lanes = 2;
    crate_real sr = (crate_real)sample_rate;
    for (int lane = 0; lane < lanes; lane++) {
        s->lane = lane;
        for (int i = 0; i < h->node_count; i++) {
            const crate_node *n = &s->plan->nodes[i];
            switch (n->kind) {
            case CK_CONST: case CK_PARAM: case CK_PORT: case CK_LANE: case CK_MUL: case CK_ADD:
            case CK_MIX: case CK_RANGE: case CK_TO_FREQUENCY: case CK_CLIP: case CK_WAVESHAPE:
            case CK_RECTIFY: case CK_COMPARE: case CK_LOGIC: case CK_QUANTIZE: case CK_SELECT:
            case CK_PAN_LAW: case CK_TRANSPORT: case CK_KERNEL: case CK_METER: case CK_CAPTURE:
                continue; /* stateless: no memory, ever */
            default: break;
            }
            crate_mem *m = memory_for(s, i);
            if (!m) { s->lane = 0; return -1; }
            int32_t len = fixed_buffer_len(n, sr);
            if (len > 0) {
                int ok = n->kind == CK_PITCH ? ensure_buf(s, m, len) : ensure_line(s, m, len);
                if (!ok) { s->lane = 0; return -1; }
            }
            if (n->kind == CK_GRAIN && !m->grains) {
                m->grains = (crate_grain *)crate_arena_alloc(s->arena, sizeof(crate_grain) * (CRATE_MAX_GRAINS + 1));
                if (!m->grains) { s->lane = 0; s->starved = 1; return -1; }
            }
            if (n->kind == CK_EUCLIDEAN && !m->pattern) {
                m->pattern = (uint8_t *)crate_arena_alloc(s->arena, CRATE_MAX_EUCLID_STEPS);
                if (!m->pattern) { s->lane = 0; s->starved = 1; return -1; }
            }
        }
    }
    s->lane = 0;
    return 0;
}

void crate_set_param_index(crate_state *s, int index, double value) {
    if (index < 0 || index >= s->plan->h->param_count) return;
    s->param_values[index] = (crate_real)value;
    s->ramp_step[index] = 0;
    s->ramp_frames[index] = 0;
    s->param_set[index] = 1;
}

void crate_set_param(crate_state *s, const char *name, double value) {
    int port = crate_plan_port_index(s->plan, name);
    if (port >= 0) s->port_scalars[port] = (crate_real)value;
    crate_set_param_index(s, crate_plan_param_index(s->plan, name), value);
}

void crate_ramp_param(crate_state *s, const char *name, double value, int frames) {
    int index = crate_plan_param_index(s->plan, name);
    if (frames <= 0 || index < 0) {
        crate_set_param(s, name, value);
        return;
    }
    s->param_set[index] = 1;
    s->ramp_step[index] = ((crate_real)value - s->param_values[index]) / (crate_real)frames;
    s->ramp_target[index] = (crate_real)value;
    s->ramp_frames[index] = frames;
    s->has_ramps = 1;
}

void crate_glide_param(crate_state *s, const char *name, double value) {
    int index = crate_plan_param_index(s->plan, name);
    int smoothed = 0;
    for (int k = 0; index >= 0 && k < s->plan->h->smooth_count; k++) {
        if (s->plan->smooth[k] == index) smoothed = 1;
    }
    if (!smoothed || s->rendered_rate <= 0 || !s->param_set[index] || s->param_values[index] == (crate_real)value) {
        crate_set_param(s, name, value);
        return;
    }
    crate_ramp_param(s, name, value, crate_param_ramp_frames(s->rendered_rate));
}

void crate_glide_param_index(crate_state *s, int index, double value) {
    if (index < 0 || index >= s->plan->h->param_count) return;
    int smoothed = 0;
    for (int k = 0; k < s->plan->h->smooth_count; k++) {
        if (s->plan->smooth[k] == index) smoothed = 1;
    }
    if (!smoothed || s->rendered_rate <= 0 || !s->param_set[index] || s->param_values[index] == (crate_real)value) {
        crate_set_param_index(s, index, value);
        return;
    }
    s->ramp_step[index] = ((crate_real)value - s->param_values[index]) / (crate_real)crate_param_ramp_frames(s->rendered_rate);
    s->ramp_target[index] = (crate_real)value;
    s->ramp_frames[index] = crate_param_ramp_frames(s->rendered_rate);
    s->has_ramps = 1;
}

/* The value a `param` node sees at `frame`: pure in the frame. */
static inline crate_real param_value(const crate_state *s, int index, int frame) {
    int32_t remaining = s->ramp_frames[index];
    if (remaining == 0) return s->param_values[index];
    return s->param_values[index] + s->ramp_step[index] * (crate_real)imin(frame, remaining);
}

static void commit_ramps(crate_state *s, int frames) {
    if (!s->has_ramps) return;
    int still = 0;
    for (int i = 0; i < s->plan->h->param_count; i++) {
        int32_t remaining = s->ramp_frames[i];
        if (remaining == 0) continue;
        if (frames >= remaining) {
            s->param_values[i] = s->ramp_target[i];
            s->ramp_step[i] = 0;
            s->ramp_frames[i] = 0;
        } else {
            s->param_values[i] += s->ramp_step[i] * (crate_real)frames;
            s->ramp_frames[i] = remaining - frames;
            still = 1;
        }
    }
    s->has_ramps = still;
}

void crate_set_port(crate_state *s, int index, const float *left, const float *right) {
    if (index < 0 || index >= s->plan->h->port_count) return;
    s->port_l[index] = left;
    s->port_r[index] = right;
}

/* ---------------------------------------------------------------------------
 * Evaluation
 * ------------------------------------------------------------------------ */

static crate_real eval(crate_state *s, int slot, crate_real sr);

/* An input's value: a load from the cache when this frame already has it,
 * the recursive walk otherwise. 0 for an input that is not wired. */
static inline crate_real ev(crate_state *s, const crate_node *n, int input, crate_real sr) {
    int child = n->in[input];
    if (child < 0) return 0;
    if (s->stamps[child] == s->generation) return s->values[child];
    return eval(s, child, sr);
}

#define HAS(n, input) ((n)->in[input] >= 0)

/* Whether a rising edge arrived on `reset` this sample. */
static inline int reset_rose(crate_state *s, const crate_node *n, crate_real sr, crate_mem *m) {
    if (!HAS(n, CI_RESET)) return 0;
    crate_real value = eval(s, n->in[CI_RESET], sr);
    int rose = value > RL(0.5) && m->prev_reset <= RL(0.5);
    m->prev_reset = value;
    return rose;
}

static inline const double *node_a(const crate_state *s, const crate_node *n) { return s->plan->numbers + n->a_off; }
static inline const double *node_b(const crate_state *s, const crate_node *n) { return s->plan->numbers + n->b_off; }
static inline const float *node_table(const crate_state *s, const crate_node *n) { return s->plan->tables + n->table_off; }
static inline int list_at(const crate_state *s, const crate_node *n, int i) { return s->plan->index[n->list_off + (uint32_t)i]; }

/* --- Envelopes ------------------------------------------------------------ */

static crate_real eval_adsr(crate_state *s, const crate_node *n, crate_real sr) {
    const double *p = node_a(s, n);
    crate_real a = n->a_len > 0 ? (crate_real)p[0] : 0;
    crate_real d = n->a_len > 1 ? (crate_real)p[1] : 0;
    crate_real sus = n->a_len > 2 ? (crate_real)p[2] : 0;
    crate_real r = n->a_len > 3 ? (crate_real)p[3] : 0;
    crate_real velocity = ev(s, n, CI_TRIGGER, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    if (s->gate && !m->last_gate) {
        m->stage = ST_ATTACK;
        m->peak = velocity;
        m->stage_elapsed = 0;
        m->stage_start_level = m->level;
    } else if (!s->gate && m->last_gate) {
        m->stage = ST_RELEASE;
        m->stage_elapsed = 0;
        m->stage_start_level = m->level;
    }
    m->last_gate = (uint8_t)(s->gate != 0);
    crate_real dt = 1 / sr;
    switch (m->stage) {
    case ST_IDLE: m->level = 0; break;
    case ST_ATTACK: {
        m->stage_elapsed += dt;
        crate_real t = rmin(m->stage_elapsed / rmax(a, RL(1e-6)), 1);
        m->level = m->stage_start_level + (m->peak - m->stage_start_level) * t;
        if (t >= 1) {
            m->stage = ST_DECAY;
            m->stage_elapsed = 0;
            m->stage_start_level = m->level;
        }
        break;
    }
    case ST_DECAY: {
        m->stage_elapsed += dt;
        crate_real target = sus * m->peak;
        crate_real t = rmin(m->stage_elapsed / rmax(d, RL(1e-6)), 1);
        m->level = m->stage_start_level + (target - m->stage_start_level) * t;
        if (t >= 1) m->stage = ST_SUSTAIN;
        break;
    }
    case ST_SUSTAIN: m->level = sus * m->peak; break;
    case ST_RELEASE: {
        m->stage_elapsed += dt;
        crate_real t = rmin(m->stage_elapsed / rmax(r, RL(1e-6)), 1);
        m->level = m->stage_start_level * (1 - t);
        if (t >= 1) {
            m->stage = ST_IDLE;
            m->level = 0;
        }
        break;
    }
    default: break;
    }
    return m->level;
}

/* Keeps a stage's fraction done when its duration moves, so the level stays
 * continuous instead of jumping. `k3` is the duration as last seen, NaN at a
 * stage's start. */
static inline void follow_duration(crate_mem *m, crate_real dur) {
    if (m->k3 == dur) return;
    if (!isnan(m->k3)) m->stage_elapsed = (m->stage_elapsed / m->k3) * dur;
    m->k3 = dur;
}

static crate_real eval_dahdsr(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real velocity = ev(s, n, CI_TRIGGER, sr);
    crate_real delay = rmax(ev(s, n, CI_DELAY, sr), 0);
    crate_real attack = rmax(ev(s, n, CI_ATTACK, sr), 0);
    crate_real hold = rmax(ev(s, n, CI_HOLD, sr), 0);
    crate_real decay = rmax(ev(s, n, CI_DECAY, sr), 0);
    crate_real sustain = rmin(rmax(ev(s, n, CI_SUSTAIN, sr), 0), 1);
    crate_real release = rmax(ev(s, n, CI_RELEASE, sr), 0);
    int signal_gate = HAS(n, CI_GATE) ? ev(s, n, CI_GATE, sr) > RL(0.5) : 0;
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    /* The voice's gate until the gate cable first rises, the cable's after,
     * and a rise on the cable retriggers outright. */
    int rose = signal_gate && !m->prev_gate;
    m->prev_gate = (uint8_t)signal_gate;
    if (rose) m->armed = 1;
    int gated = m->armed ? signal_gate : (s->gate != 0);

    if ((gated && !m->last_gate) || rose) {
        m->peak = velocity;
        m->stage_elapsed = 0;
        m->stage_start_level = m->level;
        m->stage = delay > RL(1e-6) ? ST_DELAY : ST_ATTACK;
        m->k3 = (crate_real)NAN;
    } else if (!gated && m->last_gate) {
        m->stage = ST_RELEASE;
        m->stage_elapsed = 0;
        m->stage_start_level = m->level;
        m->k3 = (crate_real)NAN;
    }
    m->last_gate = (uint8_t)gated;

    m->stage_elapsed += 1 / sr;

    if (m->stage == ST_IDLE) {
        m->level = 0;
    } else if (m->stage == ST_DELAY) {
        m->level = m->stage_start_level;
        if (m->stage_elapsed >= delay) {
            m->stage = ST_ATTACK;
            m->stage_elapsed = 0;
            m->stage_start_level = m->level;
            m->k3 = (crate_real)NAN;
        }
    }
    if (m->stage == ST_ATTACK) {
        follow_duration(m, rmax(attack, RL(1e-6)));
        crate_real t = rmin(m->stage_elapsed / rmax(attack, RL(1e-6)), 1);
        m->level = m->stage_start_level + (m->peak - m->stage_start_level) * t;
        if (t >= 1) {
            m->stage = hold > RL(1e-6) ? ST_HOLD : ST_DECAY;
            m->stage_elapsed = 0;
            m->stage_start_level = m->level;
            m->k3 = (crate_real)NAN;
        }
    }
    if (m->stage == ST_HOLD) {
        m->level = m->peak;
        if (m->stage_elapsed >= hold) {
            m->stage = ST_DECAY;
            m->stage_elapsed = 0;
            m->stage_start_level = m->level;
            m->k3 = (crate_real)NAN;
        }
    }
    if (m->stage == ST_DECAY) {
        crate_real target = sustain * m->peak;
        follow_duration(m, rmax(decay, RL(1e-6)));
        crate_real t = rmin(m->stage_elapsed / rmax(decay, RL(1e-6)), 1);
        m->level = m->stage_start_level + (target - m->stage_start_level) * t;
        if (t >= 1) m->stage = ST_SUSTAIN;
    }
    if (m->stage == ST_SUSTAIN) {
        m->level = sustain * m->peak;
    }
    if (m->stage == ST_RELEASE) {
        follow_duration(m, rmax(release, RL(1e-6)));
        crate_real t = rmin(m->stage_elapsed / rmax(release, RL(1e-6)), 1);
        m->level = m->stage_start_level * (1 - t);
        if (t >= 1) {
            m->stage = ST_IDLE;
            m->level = 0;
        }
    }
    return m->level;
}

static crate_real eval_breakpoints(crate_state *s, const crate_node *n, crate_real sr) {
    int gated = HAS(n, CI_GATE) ? ev(s, n, CI_GATE, sr) > RL(0.5) : (s->gate != 0);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    if (gated && !m->prev_gate) m->stage_elapsed = 0;
    m->prev_gate = (uint8_t)gated;
    if (!gated) return 0;
    m->stage_elapsed += 1 / sr;
    if (n->list_count >= 2) {
        crate_real prev_t = eval(s, list_at(s, n, 0), sr);
        crate_real prev_l = eval(s, list_at(s, n, 1), sr);
        if (m->stage_elapsed <= prev_t) return prev_l;
        int i = 2;
        while (i + 1 < n->list_count) {
            crate_real t = rmax(eval(s, list_at(s, n, i), sr), prev_t);
            crate_real level = eval(s, list_at(s, n, i + 1), sr);
            if (m->stage_elapsed <= t) {
                crate_real span = rmax(t - prev_t, RL(1e-9));
                return prev_l + (level - prev_l) * ((m->stage_elapsed - prev_t) / span);
            }
            prev_t = t;
            prev_l = level;
            i += 2;
        }
        return prev_l;
    }
    const double *times = node_a(s, n);
    const double *levels = node_b(s, n);
    int tn = n->a_len, ln = n->b_len;
    if (tn == 0 || ln == 0) return 0;
    if (m->stage_elapsed <= (crate_real)times[0]) return (crate_real)levels[0];
    int i = 1;
    while (i < tn && i < ln) {
        if (m->stage_elapsed <= (crate_real)times[i]) {
            crate_real span = rmax((crate_real)times[i] - (crate_real)times[i - 1], RL(1e-9));
            crate_real t = (m->stage_elapsed - (crate_real)times[i - 1]) / span;
            return (crate_real)levels[i - 1] + ((crate_real)levels[i] - (crate_real)levels[i - 1]) * t;
        }
        i++;
    }
    return (crate_real)levels[imin(ln, tn) - 1];
}

static crate_real eval_impulse(crate_state *s, const crate_node *n, crate_real sr) {
    int has_gate = HAS(n, CI_GATE);
    int gated = has_gate ? ev(s, n, CI_GATE, sr) > RL(0.5) : (s->gate != 0);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    if (!m->initialized) {
        /* Armed when nothing gates it, so a bare impulse fires once at the
         * top of the voice rather than waiting for an edge. */
        m->armed = (uint8_t)!has_gate;
        m->initialized = 1;
    }
    int rose = gated && !m->prev_gate;
    m->prev_gate = (uint8_t)gated;
    if (m->armed || rose) {
        m->armed = 0;
        return 1;
    }
    return 0;
}

/* --- Biquads --------------------------------------------------------------- */

static inline void set_biquad(crate_mem *m, crate_real k0, crate_real k1, crate_real k2, crate_real k3,
                              crate_real b0, crate_real b1, crate_real b2,
                              crate_real a0, crate_real a1, crate_real a2) {
    m->n0 = b0 / a0;
    m->n1 = b1 / a0;
    m->n2 = b2 / a0;
    m->d1 = a1 / a0;
    m->d2 = a2 / a0;
    m->k0 = k0;
    m->k1 = k1;
    m->k2 = k2;
    m->k3 = k3;
}

static inline crate_real tick_biquad(crate_mem *m, crate_real input) {
    crate_real y = m->n0 * input + m->n1 * m->x1 + m->n2 * m->x2 - m->d1 * m->y1 - m->d2 * m->y2;
    m->x2 = m->x1;
    m->x1 = input;
    m->y2 = m->y1;
    m->y1 = y;
    return y;
}

enum { RBJ_LOWPASS, RBJ_HIGHPASS, RBJ_BANDPASS, RBJ_NOTCH };

static crate_real eval_rbj(crate_state *s, const crate_node *n, crate_real sr, int kind) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real cutoff = ev(s, n, CI_CUTOFF, sr);
    crate_real q = ev(s, n, CI_Q, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    if (m->k0 != cutoff || m->k1 != q || m->k2 != sr) {
        crate_real clamped = rmin(rmax(cutoff, 1), sr / 2 - 1);
        crate_real omega = (2 * PI_R * clamped) / sr;
        crate_real sinw = R(sin)(omega);
        crate_real cosw = R(cos)(omega);
        crate_real alpha = sinw / (2 * rmax(q, RL(1e-4)));
        crate_real a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
        crate_real b0 = 0, b1 = 0, b2 = 0;
        switch (kind) {
        case RBJ_LOWPASS: b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2; break;
        case RBJ_HIGHPASS: b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2; break;
        case RBJ_BANDPASS: b0 = alpha; b1 = 0; b2 = -alpha; break;
        default: b0 = 1; b1 = -2 * cosw; b2 = 1; break;
        }
        set_biquad(m, cutoff, q, sr, 0, b0, b1, b2, a0, a1, a2);
    }
    return tick_biquad(m, input);
}

static crate_real eval_peaking(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real freq = ev(s, n, CI_FREQ, sr);
    crate_real gain_db = ev(s, n, CI_GAIN_DB, sr);
    crate_real q = ev(s, n, CI_Q, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    if (m->k0 != freq || m->k1 != gain_db || m->k2 != q || m->k3 != sr) {
        crate_real clamped = rmin(rmax(freq, 1), sr / 2 - 1);
        crate_real a = R(pow)(10, gain_db / 40);
        crate_real omega = (2 * PI_R * clamped) / sr;
        crate_real alpha = R(sin)(omega) / (2 * rmax(q, RL(1e-4)));
        crate_real cosw = R(cos)(omega);
        set_biquad(m, freq, gain_db, q, sr,
                   1 + alpha * a, -2 * cosw, 1 - alpha * a,
                   1 + alpha / a, -2 * cosw, 1 - alpha / a);
    }
    return tick_biquad(m, input);
}

static crate_real eval_shelf(crate_state *s, const crate_node *n, crate_real sr, int low) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real freq = ev(s, n, CI_FREQ, sr);
    crate_real gain_db = ev(s, n, CI_GAIN_DB, sr);
    crate_real q = ev(s, n, CI_Q, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    if (gain_db == 0) {
        /* At 0 dB the coefficients degenerate to identity: take the exact
         * bypass, and invalidate so leaving it recomputes. */
        m->x2 = m->x1;
        m->x1 = input;
        m->y2 = m->y1;
        m->y1 = input;
        m->k0 = (crate_real)NAN;
        return input;
    }
    if (m->k0 != freq || m->k1 != gain_db || m->k2 != q || m->k3 != sr) {
        crate_real clamped = rmin(rmax(freq, 1), sr / 2 - 1);
        crate_real a = R(pow)(10, gain_db / 40);
        crate_real omega = (2 * PI_R * clamped) / sr;
        crate_real sinw = R(sin)(omega);
        crate_real cosw = R(cos)(omega);
        /* Radicand floored at 0.01 (Q 10), SHELF_MIN_RADICAND in compile.ts. */
        crate_real alpha = (sinw / 2) * R(sqrt)(rmax(RL(0.01), (a + 1 / a) * (1 / rmax(q, RL(1e-4)) - 1) + 2));
        crate_real sq_a = R(sqrt)(a);
        crate_real a0, a1, a2, b0, b1, b2;
        if (low) {
            a0 = a + 1 + (a - 1) * cosw + 2 * sq_a * alpha;
            b0 = a * (a + 1 - (a - 1) * cosw + 2 * sq_a * alpha);
            b1 = 2 * a * (a - 1 - (a + 1) * cosw);
            b2 = a * (a + 1 - (a - 1) * cosw - 2 * sq_a * alpha);
            a1 = -2 * (a - 1 + (a + 1) * cosw);
            a2 = a + 1 + (a - 1) * cosw - 2 * sq_a * alpha;
        } else {
            a0 = a + 1 - (a - 1) * cosw + 2 * sq_a * alpha;
            b0 = a * (a + 1 + (a - 1) * cosw + 2 * sq_a * alpha);
            b1 = -2 * a * (a - 1 + (a + 1) * cosw);
            b2 = a * (a + 1 + (a - 1) * cosw - 2 * sq_a * alpha);
            a1 = 2 * (a - 1 - (a + 1) * cosw);
            a2 = a + 1 - (a - 1) * cosw - 2 * sq_a * alpha;
        }
        set_biquad(m, freq, gain_db, q, sr, b0, b1, b2, a0, a1, a2);
    }
    return tick_biquad(m, input);
}

static crate_real eval_allpass(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real cutoff = ev(s, n, CI_CUTOFF, sr);
    crate_real q = ev(s, n, CI_Q, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    if (m->k0 != cutoff || m->k1 != q || m->k2 != sr) {
        crate_real clamped = rmin(rmax(cutoff, 1), sr / 2 - 1);
        crate_real omega = (2 * PI_R * clamped) / sr;
        crate_real sinw = R(sin)(omega);
        crate_real cosw = R(cos)(omega);
        crate_real alpha = sinw / (2 * rmax(q, RL(1e-4)));
        set_biquad(m, cutoff, q, sr, 0, 1 - alpha, -2 * cosw, 1 + alpha, 1 + alpha, -2 * cosw, 1 - alpha);
    }
    return tick_biquad(m, input);
}

/* --- One-pole and state-variable filters ----------------------------------- */

static crate_real eval_one_pole(crate_state *s, const crate_node *n, crate_real sr, int low) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real cutoff = ev(s, n, CI_CUTOFF, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    if (m->k0 != cutoff || m->k1 != sr) {
        crate_real clamped = rmin(rmax(cutoff, 1), sr / 2 - 1);
        m->c0 = 1 - R(exp)((-2 * PI_R * clamped) / sr);
        m->k0 = cutoff;
        m->k1 = sr;
    }
    m->s0 += m->c0 * (input - m->s0);
    return low ? m->s0 : input - m->s0;
}

static crate_real eval_svf(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real cutoff = ev(s, n, CI_CUTOFF, sr);
    crate_real q = ev(s, n, CI_Q, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    if (m->k0 != cutoff || m->k1 != sr) {
        crate_real clamped = rmin(rmax(cutoff, 1), sr * RL(0.25));
        m->c0 = 2 * R(sin)((PI_R * clamped) / sr);
        m->k0 = cutoff;
        m->k1 = sr;
    }
    /* SVF_MIN_DAMP and SVF_STABILITY, as compile.ts. */
    crate_real damp = rmin(RL(1.98), rmax(RL(1e-4), 1 / rmax(q, RL(0.05))));
    if (m->k2 != damp) {
        m->c1 = -damp + R(sqrt)(damp * damp + RL(3.96));
        m->k2 = damp;
    }
    crate_real f = rmin(m->c0, m->c1);
    m->s0 += f * m->s1;
    crate_real high = input - m->s0 - damp * m->s1;
    m->s1 += f * high;
    if (n->m == 1) return high;
    if (n->m == 2) return m->s1;
    return m->s0;
}

static crate_real eval_ladder(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real cutoff = ev(s, n, CI_CUTOFF, sr);
    crate_real resonance = ev(s, n, CI_RESONANCE, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    if (m->k0 != cutoff || m->k1 != sr) {
        crate_real clamped = rmin(rmax(cutoff, 1), sr / 2 - 1);
        m->c0 = 1 - R(exp)((-2 * PI_R * clamped) / sr);
        m->k0 = cutoff;
        m->k1 = sr;
    }
    crate_real g = m->c0;
    crate_real k = rmin(rmax(resonance, 0), RL(0.99)) * 4;
    /* Drive 1 is the identity by branch, not by formula, so a ladder that
     * already exists sounds like itself; near zero is the formula's limit. */
    crate_real drive = HAS(n, CI_DRIVE) ? ev(s, n, CI_DRIVE, sr) : 1;
    crate_real driven = (drive == 1 || R(fabs)(drive) < RL(1e-6)) ? input : R(tanh)(input * drive) / R(tanh)(drive);
    crate_real x = driven - k * R(tanh)(m->s3);
    m->s0 += g * (x - m->s0);
    m->s1 += g * (m->s0 - m->s1);
    m->s2 += g * (m->s1 - m->s2);
    m->s3 += g * (m->s2 - m->s3);
    return m->s3;
}

static crate_real eval_filter_slope(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real cutoff = ev(s, n, CI_CUTOFF, sr);
    int poles = (int)n->c;
    int highpass = n->m == 1;
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    if (m->k0 != cutoff || m->k1 != sr) {
        crate_real clamped = rmin(rmax(cutoff, 1), sr / 2 - 1);
        m->c0 = 1 - R(exp)((-2 * PI_R * clamped) / sr);
        m->k0 = cutoff;
        m->k1 = sr;
    }
    crate_real g = m->c0;
    crate_real x = input;
    crate_real *stages[4] = { &m->s0, &m->s1, &m->s2, &m->s3 };
    for (int i = 0; i < poles; i++) {
        crate_real *st = stages[i < 3 ? i : 3];
        *st += g * (x - *st);
        x = highpass ? x - *st : *st;
    }
    return x;
}

/* --- Lines ----------------------------------------------------------------- */

/* The read pointer's glide toward `target`, for `delay` and `comb`. A time
 * that steps would move the read pointer to an unrelated part of the buffer
 * and click; it glides over about 20 ms instead. The first sample takes the
 * target exactly. */
static inline crate_real glide_read_pointer(crate_mem *m, crate_real target, crate_real sr) {
    if (m->k1 != sr) {
        m->c0 = 1 - R(exp)(-1 / (RL(0.02) * sr));
        m->k1 = sr;
    }
    if (!m->initialized) {
        m->pos = target;
        m->initialized = 1;
    } else {
        m->pos += (target - m->pos) * m->c0;
    }
    return m->pos;
}

static crate_real eval_comb(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real freq = ev(s, n, CI_FREQ, sr);
    crate_real feedback = ev(s, n, CI_FEEDBACK, sr);
    crate_real wet = ev(s, n, CI_MIX, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m || !ensure_line(s, m, (int32_t)rmax(2, R(ceil)(sr / 20) + 2))) return input;
    crate_real len = (crate_real)m->buf_len;
    crate_real target = rmin(rmax(sr / rmax(freq, 20), 1), len - 2);
    crate_real read = (crate_real)m->write_idx - glide_read_pointer(m, target, sr);
    int i0 = (int)js_wrap(R(floor)(read), len);
    int i1 = (i0 + 1) % m->buf_len;
    crate_real frac = read - R(floor)(read);
    crate_real delayed = LINE_GET(m, i0) * (1 - frac) + LINE_GET(m, i1) * frac;
    LINE_SET(m, m->write_idx, input + delayed * rmin(rmax(feedback, RL(-0.99)), RL(0.99)));
    m->write_idx = (m->write_idx + 1) % m->buf_len;
    crate_real mix = rmin(rmax(wet, 0), 1);
    return input * (1 - mix) + delayed * mix;
}

static crate_real eval_delay(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real time_sec = ev(s, n, CI_TIME_SEC, sr);
    crate_real feedback = ev(s, n, CI_FEEDBACK, sr);
    crate_real wet = ev(s, n, CI_MIX, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m || !ensure_line(s, m, fixed_buffer_len(n, sr))) {
        /* No line: the dry half of the mix, so a starved delay is an echo
         * that went missing rather than a track that went quiet. */
        return input * (1 - rmin(rmax(wet, 0), 1));
    }
    crate_real len = (crate_real)m->buf_len;
    crate_real target = rmin(rmax(time_sec, 0) * sr, len - 2);
    crate_real read = (crate_real)m->write_idx - glide_read_pointer(m, target, sr);
    int i0 = (int)js_wrap(R(floor)(read), len);
    int i1 = (i0 + 1) % m->buf_len;
    crate_real frac = read - R(floor)(read);
    crate_real delayed = LINE_GET(m, i0) * (1 - frac) + LINE_GET(m, i1) * frac;
    LINE_SET(m, m->write_idx, input + delayed * rmin(rmax(feedback, RL(-0.99)), RL(0.99)));
    m->write_idx = (m->write_idx + 1) % m->buf_len;
    crate_real mix = rmin(rmax(wet, 0), 1);
    return input * (1 - mix) + delayed * mix;
}

static crate_real eval_reverse(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real time_sec = rmax(ev(s, n, CI_TIME_SEC, sr), 1 / sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m || !ensure_line(s, m, fixed_buffer_len(n, sr))) return 0;
    int span = (int)rmin(rmax(js_round(time_sec * sr), 2), (crate_real)m->buf_len);
    LINE_SET(m, m->write_idx % span, input);
    m->write_idx += 1;
    m->read_idx = (m->read_idx - 1 + span) % span;
    return m->read_idx < m->buf_len ? LINE_GET(m, m->read_idx) : 0;
}

static crate_real eval_looper(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    int rec = ev(s, n, CI_RECORD, sr) > RL(0.5);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m || !ensure_line(s, m, fixed_buffer_len(n, sr))) return 0;
    int clearing = HAS(n, CI_TRIGGER) ? ev(s, n, CI_TRIGGER, sr) > RL(0.5) : 0;
    if (clearing && !m->armed) {
        m->write_idx = 0;
        m->length = 0;
        m->read_idx = 0;
    }
    m->armed = (uint8_t)clearing;
    int cap;
    if (HAS(n, CI_DURATION)) {
        crate_real dur = rmax(ev(s, n, CI_DURATION, sr), 1 / sr);
        cap = imin(m->buf_len, imax(2, (int)R(ceil)(dur * sr)));
    } else {
        cap = m->buf_len;
    }
    if (rec && !m->prev_gate) {
        m->write_idx = 0;
        m->length = 0;
        m->read_idx = 0;
    }
    m->prev_gate = (uint8_t)rec;
    if (rec) {
        if (m->write_idx < cap) {
            LINE_SET(m, m->write_idx, input);
            m->write_idx += 1;
            m->length = m->write_idx;
        }
        return n->m == 0 ? input : 0;
    }
    int play_len = imin(m->length, cap);
    if (play_len <= 0) return 0;
    if (m->read_idx >= play_len) m->read_idx = 0;
    crate_real start = m->read_idx == 0 ? 1 : 0;
    crate_real end = m->read_idx == play_len - 1 ? 1 : 0;
    crate_real out = m->read_idx < m->buf_len ? LINE_GET(m, m->read_idx) : 0;
    m->read_idx = (m->read_idx + 1) % play_len;
    if (n->m == 1) return start;
    if (n->m == 2) return end;
    return out;
}

/* --- Dynamics -------------------------------------------------------------- */

static inline crate_real follower_coeff(crate_mem *m, crate_real time, crate_real sr, int rising) {
    if (m->k0 != sr) {
        m->k0 = sr;
        m->ka = (crate_real)NAN;
        m->kr = (crate_real)NAN;
    }
    if (rising) {
        if (m->ka != time) {
            m->ca = 1 - R(exp)(-1 / (time * sr));
            m->ka = time;
        }
        return m->ca;
    }
    if (m->kr != time) {
        m->cr = 1 - R(exp)(-1 / (time * sr));
        m->kr = time;
    }
    return m->cr;
}

static crate_real eval_env_follow(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real attack = rmax(ev(s, n, CI_ATTACK, sr), RL(1e-5));
    crate_real release = rmax(ev(s, n, CI_RELEASE, sr), RL(1e-5));
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    crate_real target = R(fabs)(input);
    int rising = target > m->env;
    m->env += (target - m->env) * follower_coeff(m, rising ? attack : release, sr, rising);
    return m->env;
}

static crate_real eval_compressor(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real detect = HAS(n, CI_SIDECHAIN) ? ev(s, n, CI_SIDECHAIN, sr) : input;
    crate_real threshold = rmax(ev(s, n, CI_THRESHOLD, sr), RL(1e-6));
    crate_real ratio = rmax(ev(s, n, CI_RATIO, sr), 1);
    crate_real attack = rmax(ev(s, n, CI_ATTACK, sr), RL(1e-5));
    crate_real release = rmax(ev(s, n, CI_RELEASE, sr), RL(1e-5));
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    crate_real target = R(fabs)(detect);
    int rising = target > m->env;
    m->env += (target - m->env) * follower_coeff(m, rising ? attack : release, sr, rising);
    if (m->env <= threshold) return input;
    return input * R(pow)(threshold / m->env, 1 - 1 / ratio);
}

static crate_real eval_expander(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real threshold = rmax(ev(s, n, CI_THRESHOLD, sr), RL(1e-6));
    crate_real ratio = rmax(ev(s, n, CI_RATIO, sr), 1);
    crate_real attack = rmax(ev(s, n, CI_ATTACK, sr), RL(1e-5));
    crate_real release = rmax(ev(s, n, CI_RELEASE, sr), RL(1e-5));
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    crate_real target = R(fabs)(input);
    int rising = target > m->env;
    m->env += (target - m->env) * follower_coeff(m, rising ? attack : release, sr, rising);
    if (m->env >= threshold) return input;
    return input * R(pow)(rmax(m->env, RL(1e-6)) / threshold, ratio - 1);
}

static crate_real eval_transient(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real attack_amt = ev(s, n, CI_ATTACK, sr);
    crate_real sustain_amt = ev(s, n, CI_SUSTAIN, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return input;
    if (m->k0 != sr) {
        m->c0 = 1 - R(exp)(-1 / (RL(0.003) * sr));
        m->c1 = 1 - R(exp)(-1 / (RL(0.08) * sr));
        m->k0 = sr;
    }
    crate_real target = R(fabs)(input);
    m->s0 += (target - m->s0) * m->c0;
    m->s1 += (target - m->s1) * m->c1;
    crate_real delta = m->s0 - m->s1;
    crate_real gain = rmax(0, 1 + attack_amt * rmax(delta, 0) * 4 + sustain_amt * m->s1);
    return input * gain;
}

static crate_real eval_rms(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real window_sec = rmax(ev(s, n, CI_WINDOW_SEC, sr), 1 / sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m || !ensure_buf(s, m, (int32_t)rmax(2, js_round(window_sec * sr)))) return 0;
    crate_real sq = input * input;
    m->sum += sq - (crate_real)m->buf[m->write_idx];
    m->buf[m->write_idx] = (float)sq;
    m->write_idx = (m->write_idx + 1) % m->buf_len;
    m->filled = rmin(m->filled + 1, (crate_real)m->buf_len);
    return R(sqrt)(rmax(m->sum, 0) / m->filled);
}

static crate_real eval_peak(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real release = rmax(ev(s, n, CI_RELEASE, sr), RL(1e-5));
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    crate_real target = R(fabs)(input);
    if (target > m->peak) {
        m->peak = target;
    } else {
        if (m->k0 != release || m->k1 != sr) {
            m->c0 = R(exp)(-1 / (release * sr));
            m->k0 = release;
            m->k1 = sr;
        }
        m->peak *= m->c0;
    }
    return m->peak;
}

static crate_real eval_onset(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real threshold = ev(s, n, CI_THRESHOLD, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    if (m->k0 != sr) {
        m->c0 = 1 - R(exp)(-1 / (RL(0.005) * sr));
        m->k0 = sr;
    }
    crate_real target = R(fabs)(input);
    m->env += (target - m->env) * m->c0;
    crate_real delta = m->env - m->prev;
    m->prev = m->env;
    return delta > threshold ? 1 : 0;
}

static crate_real eval_pitch(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m || !ensure_buf(s, m, 1024)) return 0;
    int cap = m->buf_len;
    m->buf[m->write_idx] = (float)input;
    m->write_idx = (m->write_idx + 1) % cap;
    m->count += 1;
    if (m->count >= (crate_real)cap && ((long)m->count) % 512 == 0) {
        crate_real peak = 0;
        int last_sign = 0, first = -1, last = -1, crossings = 0;
        for (int i = 0; i < cap; i++) {
            crate_real sample = (crate_real)m->buf[(m->write_idx + i) % cap];
            crate_real mag = sample < 0 ? -sample : sample;
            if (mag > peak) peak = mag;
            int sign = sample > 0 ? 1 : sample < 0 ? -1 : 0;
            if (last_sign < 0 && sign > 0) {
                if (first < 0) first = i;
                last = i;
                crossings += 1;
            }
            if (sign != 0) last_sign = sign;
        }
        int span = last - first;
        crate_real min_period = sr / 2000;
        crate_real max_period = sr / 50;
        if (peak >= RL(0.01) && crossings >= 2 && span > 0) {
            crate_real period = (crate_real)span / (crate_real)(crossings - 1);
            if (period >= min_period && period <= max_period) {
                crate_real hz = sr / period;
                crate_real midi = 69 + 12 * R(log2)(hz / 440);
                m->held = hz;
                m->env = midi;
                crate_real nearest = R(round)(midi);
                crate_real cents = (midi - nearest) * 100;
                m->prev = cents == 50 ? -50 : cents;
                m->on = 1;
            } else {
                m->on = 0;
            }
        } else {
            m->on = 0;
        }
    }
    if (n->m == 1) return m->env;
    if (n->m == 2) return m->prev;
    if (n->m == 3) return m->on;
    return m->held;
}

/* --- Clocks and patterns --------------------------------------------------- */

static const int8_t quantize_scales[5][12] = {
    { 0, 2, 4, 5, 7, 9, 11 },
    { 0, 2, 3, 5, 7, 8, 10 },
    { 0, 2, 4, 7, 9 },
    { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 },
    { 0, 2, 4, 6, 8, 10 },
};
static const int8_t quantize_sizes[5] = { 7, 7, 5, 12, 6 };

static crate_real quantize_to_scale(crate_real note, crate_real root, crate_real scale_index) {
    int which = (int)rmin(rmax(js_round(scale_index), 0), 4);
    const int8_t *degrees = quantize_scales[which];
    crate_real shifted = note - root;
    crate_real octave = R(floor)(shifted / 12);
    crate_real pc = shifted - octave * 12;
    crate_real best_deg = degrees[0];
    crate_real best_dist = (crate_real)INFINITY;
    static const crate_real offsets[3] = { 0, -12, 12 };
    for (int d = 0; d < quantize_sizes[which]; d++) {
        for (int o = 0; o < 3; o++) {
            crate_real candidate = (crate_real)degrees[d] + offsets[o];
            crate_real dist = R(fabs)(candidate - pc);
            if (dist < best_dist - RL(1e-12)) {
                best_dist = dist;
                best_deg = candidate;
            }
        }
    }
    return root + octave * 12 + best_deg;
}

static crate_real eval_clock_multiply(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real factor = rmax(1, js_round(ev(s, n, CI_FACTOR, sr)));
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    if (reset_rose(s, n, sr, m)) {
        m->since = 0;
        m->interval = 0;
        m->next_at = 0;
        m->left = 0;
        m->armed = 0;
    }
    int rose = input > RL(0.5) && m->prev <= RL(0.5);
    m->prev = input;
    if (rose) {
        if (m->armed && m->since > 0) {
            m->interval = m->since / factor;
            m->next_at = 0;
            m->left = factor;
        }
        m->since = 0;
        m->armed = 1;
    }
    crate_real out = 0;
    if (m->left > 0 && m->since >= m->next_at) {
        out = 1;
        m->next_at += m->interval;
        m->left -= 1;
    }
    m->since += 1;
    return out;
}

static int euclidean_pattern(uint8_t *out, crate_real steps, crate_real hits, crate_real rotation) {
    int n = (int)rmax(1, R(floor)(steps));
    if (n > CRATE_MAX_EUCLID_STEPS) n = CRATE_MAX_EUCLID_STEPS;
    int k = (int)rmin((crate_real)n, rmax(0, R(floor)(hits)));
    uint8_t raw[CRATE_MAX_EUCLID_STEPS];
    int acc = 0;
    for (int i = 0; i < n; i++) {
        acc += k;
        if (acc >= n) {
            acc -= n;
            raw[i] = 1;
        } else {
            raw[i] = 0;
        }
    }
    int rot = (((int)R(floor)(rotation) % n) + n) % n;
    for (int i = 0; i < n; i++) out[i] = raw[(i + rot) % n];
    return n;
}

static crate_real eval_euclidean(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real steps = ev(s, n, CI_STEPS, sr);
    crate_real hits = ev(s, n, CI_HITS, sr);
    crate_real rotation = ev(s, n, CI_ROTATION, sr);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    /* Before the first step, so the next clock is step zero. The cached
     * pattern is kept: it depends on the settings, not the position. */
    if (reset_rose(s, n, sr, m)) m->index = -1;
    int rose = input > RL(0.5) && m->prev <= RL(0.5);
    m->prev = input;
    if (!rose) return 0;
    crate_real nn = rmax(1, R(floor)(steps));
    m->index = wrap_mod(m->index + 1, nn);
    if (!m->pattern) {
        m->pattern = (uint8_t *)crate_arena_alloc(s->arena, CRATE_MAX_EUCLID_STEPS);
        if (!m->pattern) { s->starved = 1; return 0; }
    }
    if (m->pattern_len == 0 || m->k0 != nn || m->k1 != hits || m->k2 != rotation) {
        m->pattern_len = euclidean_pattern(m->pattern, nn, hits, rotation);
        m->k0 = nn;
        m->k1 = hits;
        m->k2 = rotation;
    }
    int index = (int)m->index;
    return index >= 0 && index < m->pattern_len && m->pattern[index] ? 1 : 0;
}

static crate_real eval_random(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real freq = rmax(ev(s, n, CI_FREQ, sr), 0);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    if (!m->initialized) {
        m->phase = 1;
        m->rng = stream_seed(s->seed, n->ix, s->lane);
        m->initialized = 1;
    }
    m->phase += freq / sr;
    if (m->phase >= 1) {
        m->phase -= R(floor)(m->phase);
        /* s0 is the value being left, s1 the one being approached. */
        m->s0 = m->s1;
        m->s1 = next_uniform(&m->rng) * 2 - 1;
    }
    if (n->m == 1) return m->s0 + (m->s1 - m->s0) * m->phase;
    return m->s1;
}

/* --- Sources --------------------------------------------------------------- */

static inline crate_real noise_pink(crate_mem *m, crate_real white) {
    m->s0 = RL(0.99886) * m->s0 + white * RL(0.0555179);
    m->s1 = RL(0.99332) * m->s1 + white * RL(0.0750759);
    m->s2 = RL(0.969) * m->s2 + white * RL(0.153852);
    return rmin(1, rmax(-1, (m->s0 + m->s1 + m->s2 + white * RL(0.3104856)) * RL(0.55)));
}

static inline crate_real noise_brown(crate_mem *m, crate_real white) {
    m->s3 = (m->s3 + white * RL(0.02)) * RL(0.996);
    return rmin(1, rmax(-1, m->s3 * RL(3.5)));
}

static crate_real eval_noise(crate_state *s, const crate_node *n, crate_real sr) {
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    if (!m->initialized) {
        m->rng = stream_seed(s->seed, n->ix, s->lane);
        m->initialized = 1;
    }
    /* Drawn before the colour is read, as in compile.ts. */
    crate_real white = next_uniform(&m->rng) * 2 - 1;
    int color = HAS(n, CI_COLOR) ? (int)rmin(5, rmax(0, js_round(ev(s, n, CI_COLOR, sr)))) : n->m;
    if (color == 0) return white;
    if (color == 1) return noise_pink(m, white);
    if (color == 2) return noise_brown(m, white);
    if (color == 3) {
        crate_real p = noise_pink(m, white);
        crate_real blue = (p - m->held) * 8;
        m->held = p;
        return rmin(1, rmax(-1, blue));
    }
    if (color == 4) {
        crate_real violet = (white - m->prev) * RL(0.85);
        m->prev = white;
        return rmin(1, rmax(-1, violet));
    }
    crate_real p = noise_pink(m, white);
    crate_real b = noise_brown(m, white);
    return rmin(1, rmax(-1, p * RL(0.65) + (white - b * RL(0.35)) * RL(0.4)));
}

static inline crate_real wavetable_lookup(const float *table, crate_real phase, int frame, int frame_size) {
    int base = frame * frame_size;
    crate_real idx = phase * (crate_real)frame_size;
    int i0 = (int)js_wrap(R(floor)(idx), (crate_real)frame_size);
    int i1 = (i0 + 1) % frame_size;
    crate_real frac = idx - R(floor)(idx);
    return (crate_real)table[base + i0] * (1 - frac) + (crate_real)table[base + i1] * frac;
}

static crate_real eval_wavetable(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real freq = ev(s, n, CI_FREQ, sr);
    int count = (int)n->table_len;
    if (count == 0) return 0;
    const float *table = node_table(s, n);
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    int requested = n->c > 0 ? imax(1, (int)round(n->c)) : count;
    int frame_size = count >= requested * 2 ? requested : count;
    int frames = imax(1, count / frame_size);
    crate_real out = wavetable_lookup(table, m->phase, 0, frame_size);
    if (frames > 1 && HAS(n, CI_POSITION)) {
        crate_real position = rmin(1, rmax(0, ev(s, n, CI_POSITION, sr)));
        crate_real f = position * (crate_real)(frames - 1);
        int f0 = (int)R(floor)(f);
        int f1 = imin(frames - 1, f0 + 1);
        crate_real frac = f - (crate_real)f0;
        out = wavetable_lookup(table, m->phase, f0, frame_size) * (1 - frac)
            + wavetable_lookup(table, m->phase, f1, frame_size) * frac;
    }
    m->phase = wrap_mod(m->phase + freq / sr, 1);
    return out;
}

static crate_real eval_sample_play(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real rate = ev(s, n, CI_RATE, sr);
    int signal_gate = HAS(n, CI_GATE) ? ev(s, n, CI_GATE, sr) > RL(0.5) : 0;
    int gated = n->m == 1 ? signal_gate : (signal_gate || s->gate);
    int trig = HAS(n, CI_TRIG) ? ev(s, n, CI_TRIG, sr) > RL(0.5) : 0;
    int reset = HAS(n, CI_RESET) ? ev(s, n, CI_RESET, sr) > RL(0.5) : 0;
    const float *table = node_table(s, n);
    int count = (int)n->table_len;
    crate_real src_rate = n->box_rate > 0 ? (crate_real)n->box_rate : sr;
    crate_real last = (crate_real)imax(count - 1, 0);
    crate_real start_pos = HAS(n, CI_POSITION) ? rmin(rmax(ev(s, n, CI_POSITION, sr), 0), 1) * last : 0;
    int looping = HAS(n, CI_LENGTH) ? ev(s, n, CI_LENGTH, sr) > RL(0.5) : 0;
    crate_real pitch_st = HAS(n, CI_PITCH) ? ev(s, n, CI_PITCH, sr) : 0;
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    if (gated && !m->prev_gate) {
        m->pos = start_pos;
        m->playing = (uint8_t)(count > 0);
    }
    if (!gated && m->prev_gate) m->playing = 0;
    if (trig && m->prev <= RL(0.5)) {
        m->pos = start_pos;
        m->playing = (uint8_t)(count > 0);
    }
    if (reset && m->prev_reset <= RL(0.5)) m->pos = start_pos;
    m->prev_gate = (uint8_t)gated;
    m->prev = trig ? 1 : 0;
    m->prev_reset = reset ? 1 : 0;
    if (!m->playing || count < 2) return 0;
    if (m->pos >= last) {
        if (looping && last > start_pos) {
            crate_real span = last - start_pos;
            m->pos = start_pos + wrap_mod(m->pos - start_pos, span);
        } else {
            m->playing = 0;
            return 0;
        }
    }
    int i0 = (int)R(floor)(m->pos);
    crate_real frac = m->pos - (crate_real)i0;
    crate_real out = (crate_real)table[i0] * (1 - frac) + (crate_real)table[i0 + 1] * frac;
    m->pos += rmax(rate, 0) * R(pow)(2, pitch_st / 12) * (src_rate / sr);
    return out;
}

static crate_real eval_grain(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real duration = rmax(ev(s, n, CI_DURATION, sr), 1 / sr);
    crate_real position = ev(s, n, CI_POSITION, sr);
    crate_real rate = ev(s, n, CI_RATE, sr);
    crate_real trig = ev(s, n, CI_TRIGGER, sr);
    const float *table = node_table(s, n);
    int count = (int)n->table_len;
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m) return 0;
    if (!m->grains) {
        m->grains = (crate_grain *)crate_arena_alloc(s->arena, sizeof(crate_grain) * (CRATE_MAX_GRAINS + 1));
        if (!m->grains) { s->starved = 1; return 0; }
    }
    int rose = trig > RL(0.5) && m->prev <= RL(0.5);
    m->prev = trig;
    if (rose && count > 0) {
        crate_real len = rmax(2, js_round(duration * sr));
        crate_real start = rmin(rmax(position, 0), 1) * (crate_real)imax(count - 1, 0);
        crate_grain g = { start, 0, len, rmax(rate, 0) };
        m->grains[m->grain_count++] = g;
        if (m->grain_count > CRATE_MAX_GRAINS) {
            memmove(m->grains, m->grains + 1, sizeof(crate_grain) * CRATE_MAX_GRAINS);
            m->grain_count = CRATE_MAX_GRAINS;
        }
    }
    crate_real out = 0;
    for (int g = m->grain_count - 1; g >= 0; g--) {
        crate_grain *gr = &m->grains[g];
        int i0 = (int)R(floor)(gr->pos);
        if (gr->i >= gr->n || count == 0 || i0 < 0 || i0 >= count - 1) {
            memmove(m->grains + g, m->grains + g + 1, sizeof(crate_grain) * (size_t)(m->grain_count - g - 1));
            m->grain_count -= 1;
            continue;
        }
        crate_real frac = gr->pos - (crate_real)i0;
        crate_real hann = RL(0.5) * (1 - R(cos)((2 * PI_R * gr->i) / gr->n));
        out += ((crate_real)table[i0] * (1 - frac) + (crate_real)table[i0 + 1] * frac) * hann;
        gr->pos += gr->rate;
        gr->i += 1;
    }
    return out;
}

static crate_real eval_pitch_shift(crate_state *s, const crate_node *n, crate_real sr) {
    crate_real input = ev(s, n, CI_INPUT, sr);
    crate_real raw = ev(s, n, CI_PITCH, sr);
    crate_real pitch = n->m == 1 ? R(pow)(2, raw / 12) : rmax(raw, RL(0.25));
    crate_real grain = rmax(32, js_round(RL(0.04) * sr));
    crate_mem *m = memory_for(s, (int)(n - s->plan->nodes));
    if (!m || !ensure_line(s, m, (int32_t)(grain * 4))) return 0;
    LINE_SET(m, m->write_idx, input);
    crate_real len = (crate_real)m->buf_len;
    crate_real out = 0;
    crate_real offsets[2] = { wrap_mod(m->phase, grain), wrap_mod(m->phase + grain / 2, grain) };
    for (int k = 0; k < 2; k++) {
        crate_real offset = offsets[k];
        crate_real pos = wrap_mod((crate_real)m->write_idx - offset + len * 8, len);
        int i0 = (int)R(floor)(pos);
        int i1 = (i0 + 1) % m->buf_len;
        crate_real frac = pos - R(floor)(pos);
        crate_real sample = LINE_GET(m, i0) * (1 - frac) + LINE_GET(m, i1) * frac;
        out += sample * (RL(0.5) * (1 - R(cos)(2 * PI_R * (offset / grain))));
    }
    m->phase = wrap_mod(m->phase + pitch, grain * 2);
    m->write_idx = (m->write_idx + 1) % m->buf_len;
    return out;
}

/* --- Transport ------------------------------------------------------------- */

/* Every field is derived from the block snapshot plus the frame index, with
 * no stored state, so the same frame asked twice answers the same thing.
 * The position is computed in double whatever `crate_real` is: beats grow
 * without bound over a song and a float runs out of fraction first. */
static crate_real eval_transport(crate_state *s, const crate_node *n, crate_real sr) {
    const crate_transport *t = &s->transport;
    if (n->m == 2) return (crate_real)t->bpm;
    if (n->m == 3) return t->playing ? 1 : 0;
    if (n->m == 8) return (crate_real)(t->beats_per_bar > 0 ? t->beats_per_bar : 4);
    if (n->m == 9) return (crate_real)(t->beat_unit > 0 ? t->beat_unit : 4);
    if (n->m == 7) {
        if (n->a_len == 0) return 1;
        int index = (int)js_round(ev(s, n, CI_INDEX, sr));
        return (crate_real)node_a(s, n)[imin(n->a_len - 1, imax(0, index))];
    }
    if (n->m == 6) {
        crate_real length = ev(s, n, CI_LENGTH, sr);
        return t->bpm > 0 ? (crate_real)(((double)length * 60) / t->bpm) : 0;
    }

    /* A stopped transport holds its position rather than advancing. */
    double per_sample = t->playing ? t->bpm / 60 / (double)sr : 0;
    double beats = t->beats + (double)s->frame * per_sample;

    if (n->m == 0) return (crate_real)beats;
    if (n->m == 1) {
        double per_bar = t->beats_per_bar > 0 ? t->beats_per_bar : 4;
        double unit = t->beat_unit > 0 ? t->beat_unit : 4;
        double quarters = per_bar * (4 / unit);
        return quarters > 0 ? (crate_real)(beats / quarters) : 0;
    }

    double length = (double)ev(s, n, CI_LENGTH, sr);
    if (!(length > 0)) return 0;

    if (n->m == 4) {
        double turns = beats / length;
        return (crate_real)(turns - floor(turns));
    }
    if (n->m == 5) {
        if (per_sample == 0) return 0;
        /* A boundary crossed between the previous sample and this one, with
         * the previous position computed the way that sample computed it. */
        double previous = t->beats + (double)(s->frame - 1) * per_sample;
        return floor(beats / length) != floor(previous / length) ? 1 : 0;
    }
    return 0;
}

/* A firmware build that embeds one patch can pass a header defining
 * CRATE_KIND_ENABLED(k) as a constant expression over the kinds that patch
 * uses (firmware/kinds.c writes it). Each case below then returns early for
 * a kind it never sees, and the evaluators nothing reaches drop out at link
 * time. Every other build enables every kind. */
#ifndef CRATE_KIND_ENABLED
#define CRATE_KIND_ENABLED(k) 1
#endif

/* --- The switch ------------------------------------------------------------ */

static crate_real compute(crate_state *s, int slot, crate_real sr) {
    const crate_node *n = &s->plan->nodes[slot];
    crate_mem *m;
    switch (n->kind) {
    case CK_CONST: if (!CRATE_KIND_ENABLED(CK_CONST) && n->kind == CK_CONST) return 0; return (crate_real)n->c;
    case CK_MUL: if (!CRATE_KIND_ENABLED(CK_MUL) && n->kind == CK_MUL) return 0; return ev(s, n, CI_A, sr) * ev(s, n, CI_B, sr);
    case CK_ADD: if (!CRATE_KIND_ENABLED(CK_ADD) && n->kind == CK_ADD) return 0; return ev(s, n, CI_A, sr) + ev(s, n, CI_B, sr);
    case CK_PARAM: if (!CRATE_KIND_ENABLED(CK_PARAM) && n->kind == CK_PARAM) return 0;
        return n->ix == CRATE_NONE ? 0 : param_value(s, n->ix, s->frame);
    case CK_PORT: if (!CRATE_KIND_ENABLED(CK_PORT) && n->kind == CK_PORT) return 0; {
        int index = n->ix == CRATE_NONE ? -1 : (int)n->ix;
        if (index < 0) return 0;
        const float *left = s->port_l[index];
        /* No block wired: the scalar of the same name, the per-sample path. */
        if (!left) return s->port_scalars[index];
        /* A fixed channel the source does not have reads the one it does. */
        int channel = n->m < 0 ? s->lane : n->m;
        if (channel > 0 && s->port_r[index]) return (crate_real)s->port_r[index][s->frame];
        return (crate_real)left[s->frame];
    }
    case CK_LANE: if (!CRATE_KIND_ENABLED(CK_LANE) && n->kind == CK_LANE) return 0; return (crate_real)s->lane;
    case CK_RANGE: if (!CRATE_KIND_ENABLED(CK_RANGE) && n->kind == CK_RANGE) return 0; {
        crate_real source = ev(s, n, CI_SOURCE, sr);
        return (crate_real)n->range_min + ((source + 1) / 2) * ((crate_real)n->range_max - (crate_real)n->range_min);
    }
    case CK_MIX: if (!CRATE_KIND_ENABLED(CK_MIX) && n->kind == CK_MIX) return 0; {
        crate_real sum = 0;
        for (int i = 0; i < n->list_count; i++) {
            int c = list_at(s, n, i);
            sum += s->stamps[c] == s->generation ? s->values[c] : eval(s, c, sr);
        }
        return sum;
    }
    case CK_METER: if (!CRATE_KIND_ENABLED(CK_METER) && n->kind == CK_METER) return 0;
    case CK_CAPTURE: if (!CRATE_KIND_ENABLED(CK_CAPTURE) && n->kind == CK_CAPTURE) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        /* A stereo graph evaluates once per channel; recording on both would
         * interleave a capture into nonsense. Captures are host analysis and
         * not kept here: the value passes through. */
        if (s->lane != 0 || n->ix == CRATE_NONE) return value;
        if (n->kind == CK_METER) {
            crate_real mag = value < 0 ? -value : value;
            if (mag > s->tap_peak[n->ix]) s->tap_peak[n->ix] = mag;
            s->tap_sum_sq[n->ix] += value * value;
            s->tap_count[n->ix] += 1;
        }
        return value;
    }
    case CK_TO_FREQUENCY: if (!CRATE_KIND_ENABLED(CK_TO_FREQUENCY) && n->kind == CK_TO_FREQUENCY) return 0;
        return 440 * R(pow)(2, (ev(s, n, CI_NOTE, sr) - 69) / 12);

    case CK_OSC: if (!CRATE_KIND_ENABLED(CK_OSC) && n->kind == CK_OSC) return 0;
    case CK_LFO: if (!CRATE_KIND_ENABLED(CK_LFO) && n->kind == CK_LFO) return 0; {
        int is_lfo = n->kind == CK_LFO;
        crate_real freq = is_lfo ? ev(s, n, CI_RATE, sr) : ev(s, n, CI_FREQ, sr);
        crate_real width = HAS(n, CI_WIDTH) ? ev(s, n, CI_WIDTH, sr) : RL(0.5);
        int shape = HAS(n, CI_TYPE) ? (int)rmin(7, rmax(0, js_round(ev(s, n, CI_TYPE, sr)))) : n->m;
        crate_real offset = is_lfo && HAS(n, CI_PHASE) ? ev(s, n, CI_PHASE, sr) : 0;
        m = memory_for(s, slot);
        if (!m) return 0;
        if (is_lfo && reset_rose(s, n, sr, m)) {
            /* Back to the start of the cycle: an LFO is a shape being read. */
            m->phase = 0;
            m->s0 = 0;
        }
        crate_real increment = freq / sr;
        if (shape == SH_SUPERSQUARE) {
            crate_real ratio = 1 + rmin(rmax(width, 0), 1) * 3;
            m->phase += increment;
            m->s0 += increment * ratio;
            if (m->phase >= 1) {
                m->phase -= 1;
                m->s0 = m->phase * ratio;
            }
            if (m->s0 >= 1) m->s0 -= R(floor)(m->s0);
            crate_real p0 = m->phase, p1 = m->s0;
            if (is_lfo && offset != 0) {
                p0 = wrap_mod(p0 + offset, 1); if (p0 < 0) p0 += 1;
                p1 = wrap_mod(p1 + offset, 1); if (p1 < 0) p1 += 1;
            }
            crate_real master = 2 * p0 - 1;
            crate_real slave = p1 < RL(0.5) ? RL(1.0) : RL(-1.0);
            return (master + slave) * RL(0.5);
        }
        crate_real read = m->phase;
        if (is_lfo && offset != 0) {
            /* Shifts where the shape is read without moving where it has got
             * to, so two LFOs at one rate can sit apart and stay one clock. */
            read = wrap_mod(read + offset, 1);
            if (read < 0) read += 1;
        }
        crate_real out = oscillator_sample(shape, read, width, freq, sr);
        m->phase = wrap_mod(m->phase + increment, 1);
        return out;
    }

    case CK_ADSR: if (!CRATE_KIND_ENABLED(CK_ADSR) && n->kind == CK_ADSR) return 0; return eval_adsr(s, n, sr);
    case CK_DAHDSR: if (!CRATE_KIND_ENABLED(CK_DAHDSR) && n->kind == CK_DAHDSR) return 0; return eval_dahdsr(s, n, sr);
    case CK_BREAKPOINTS: if (!CRATE_KIND_ENABLED(CK_BREAKPOINTS) && n->kind == CK_BREAKPOINTS) return 0; return eval_breakpoints(s, n, sr);
    case CK_IMPULSE: if (!CRATE_KIND_ENABLED(CK_IMPULSE) && n->kind == CK_IMPULSE) return 0; return eval_impulse(s, n, sr);

    case CK_FILTER_LOWPASS: if (!CRATE_KIND_ENABLED(CK_FILTER_LOWPASS) && n->kind == CK_FILTER_LOWPASS) return 0; return eval_rbj(s, n, sr, RBJ_LOWPASS);
    case CK_FILTER_HIGHPASS: if (!CRATE_KIND_ENABLED(CK_FILTER_HIGHPASS) && n->kind == CK_FILTER_HIGHPASS) return 0; return eval_rbj(s, n, sr, RBJ_HIGHPASS);
    case CK_FILTER_BANDPASS: if (!CRATE_KIND_ENABLED(CK_FILTER_BANDPASS) && n->kind == CK_FILTER_BANDPASS) return 0; return eval_rbj(s, n, sr, RBJ_BANDPASS);
    case CK_FILTER_NOTCH: if (!CRATE_KIND_ENABLED(CK_FILTER_NOTCH) && n->kind == CK_FILTER_NOTCH) return 0; return eval_rbj(s, n, sr, RBJ_NOTCH);
    case CK_FILTER_PEAKING: if (!CRATE_KIND_ENABLED(CK_FILTER_PEAKING) && n->kind == CK_FILTER_PEAKING) return 0; return eval_peaking(s, n, sr);
    case CK_FILTER_LOW_SHELF: if (!CRATE_KIND_ENABLED(CK_FILTER_LOW_SHELF) && n->kind == CK_FILTER_LOW_SHELF) return 0; return eval_shelf(s, n, sr, 1);
    case CK_FILTER_HIGH_SHELF: if (!CRATE_KIND_ENABLED(CK_FILTER_HIGH_SHELF) && n->kind == CK_FILTER_HIGH_SHELF) return 0; return eval_shelf(s, n, sr, 0);
    case CK_FILTER_ALLPASS: if (!CRATE_KIND_ENABLED(CK_FILTER_ALLPASS) && n->kind == CK_FILTER_ALLPASS) return 0; return eval_allpass(s, n, sr);
    case CK_ONE_POLE_LOWPASS: if (!CRATE_KIND_ENABLED(CK_ONE_POLE_LOWPASS) && n->kind == CK_ONE_POLE_LOWPASS) return 0; return eval_one_pole(s, n, sr, 1);
    case CK_ONE_POLE_HIGHPASS: if (!CRATE_KIND_ENABLED(CK_ONE_POLE_HIGHPASS) && n->kind == CK_ONE_POLE_HIGHPASS) return 0; return eval_one_pole(s, n, sr, 0);
    case CK_SVF: if (!CRATE_KIND_ENABLED(CK_SVF) && n->kind == CK_SVF) return 0; return eval_svf(s, n, sr);
    case CK_LADDER: if (!CRATE_KIND_ENABLED(CK_LADDER) && n->kind == CK_LADDER) return 0; return eval_ladder(s, n, sr);
    case CK_COMB: if (!CRATE_KIND_ENABLED(CK_COMB) && n->kind == CK_COMB) return 0; return eval_comb(s, n, sr);
    case CK_FILTER_SLOPE: if (!CRATE_KIND_ENABLED(CK_FILTER_SLOPE) && n->kind == CK_FILTER_SLOPE) return 0; return eval_filter_slope(s, n, sr);

    case CK_CLIP: if (!CRATE_KIND_ENABLED(CK_CLIP) && n->kind == CK_CLIP) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        crate_real drive = rmax(ev(s, n, CI_DRIVE, sr), RL(1e-4));
        crate_real driven = value * drive;
        if (n->m == 1) return rmin(1, rmax(-1, driven));
        return R(tanh)(driven);
    }
    case CK_WAVESHAPE: if (!CRATE_KIND_ENABLED(CK_WAVESHAPE) && n->kind == CK_WAVESHAPE) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        int count = n->a_len;
        if (count < 2) return value;
        const double *curve = node_a(s, n);
        crate_real t = rmin(1, rmax(0, (value + 1) / 2)) * (crate_real)(count - 1);
        int i0 = (int)R(floor)(t);
        int i1 = imin(count - 1, i0 + 1);
        crate_real frac = t - R(floor)(t);
        return (crate_real)curve[i0] * (1 - frac) + (crate_real)curve[i1] * frac;
    }
    case CK_BITCRUSH: if (!CRATE_KIND_ENABLED(CK_BITCRUSH) && n->kind == CK_BITCRUSH) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        crate_real bits = rmin(rmax(ev(s, n, CI_BITS, sr), 1), 16);
        m = memory_for(s, slot);
        if (!m) return value;
        if (m->k0 != bits) {
            m->c0 = R(pow)(2, bits - 1);
            m->k0 = bits;
        }
        return js_round(value * m->c0) / m->c0;
    }
    case CK_DOWNSAMPLE: if (!CRATE_KIND_ENABLED(CK_DOWNSAMPLE) && n->kind == CK_DOWNSAMPLE) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        crate_real factor = rmax(1, ev(s, n, CI_FACTOR, sr));
        m = memory_for(s, slot);
        if (!m) return value;
        if (m->count <= 0) {
            m->held = value;
            m->count = factor;
        }
        m->count -= 1;
        return m->held;
    }
    case CK_RECTIFY: if (!CRATE_KIND_ENABLED(CK_RECTIFY) && n->kind == CK_RECTIFY) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        return n->m == 1 ? rmax(value, 0) : R(fabs)(value);
    }
    case CK_DC_BLOCK: if (!CRATE_KIND_ENABLED(CK_DC_BLOCK) && n->kind == CK_DC_BLOCK) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        m = memory_for(s, slot);
        if (!m) return value;
        crate_real y = value - m->x1 + RL(0.995) * m->y1;
        m->x1 = value;
        m->y1 = y;
        return y;
    }
    case CK_SLEW: if (!CRATE_KIND_ENABLED(CK_SLEW) && n->kind == CK_SLEW) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        crate_real rise = rmax(ev(s, n, CI_RISE, sr), 0);
        crate_real fall = rmax(ev(s, n, CI_FALL, sr), 0);
        m = memory_for(s, slot);
        if (!m) return value;
        if (!m->initialized) {
            /* Starts where the signal is, not at zero. */
            m->s0 = value;
            m->initialized = 1;
        }
        crate_real delta = value - m->s0;
        if (delta > 0) m->s0 += rmin(delta, rise / sr);
        else m->s0 += rmax(delta, -fall / sr);
        return m->s0;
    }
    case CK_SAMPLE_HOLD: if (!CRATE_KIND_ENABLED(CK_SAMPLE_HOLD) && n->kind == CK_SAMPLE_HOLD) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        crate_real freq = rmax(ev(s, n, CI_FREQ, sr), 0);
        m = memory_for(s, slot);
        if (!m) return value;
        if (!m->initialized) {
            m->held = value;
            m->phase = 1;
            m->initialized = 1;
        }
        if (HAS(n, CI_CLOCK)) {
            crate_real clock = ev(s, n, CI_CLOCK, sr);
            int rose = clock > RL(0.5) && m->prev <= RL(0.5);
            m->prev = clock;
            if (rose) m->held = value;
        }
        if (freq > 0) {
            m->phase += freq / sr;
            if (m->phase >= 1) {
                m->held = value;
                m->phase -= R(floor)(m->phase);
            }
        }
        return m->held;
    }
    case CK_COMPARE: if (!CRATE_KIND_ENABLED(CK_COMPARE) && n->kind == CK_COMPARE) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        crate_real threshold = ev(s, n, CI_THRESHOLD, sr);
        if (n->m == 1) return value < threshold ? 1 : 0;
        return value > threshold ? 1 : 0;
    }
    case CK_COMPRESSOR: if (!CRATE_KIND_ENABLED(CK_COMPRESSOR) && n->kind == CK_COMPRESSOR) return 0; return eval_compressor(s, n, sr);
    case CK_EXPANDER: if (!CRATE_KIND_ENABLED(CK_EXPANDER) && n->kind == CK_EXPANDER) return 0; return eval_expander(s, n, sr);
    case CK_TRANSIENT: if (!CRATE_KIND_ENABLED(CK_TRANSIENT) && n->kind == CK_TRANSIENT) return 0; return eval_transient(s, n, sr);
    case CK_ENV_FOLLOW: if (!CRATE_KIND_ENABLED(CK_ENV_FOLLOW) && n->kind == CK_ENV_FOLLOW) return 0; return eval_env_follow(s, n, sr);
    case CK_RMS: if (!CRATE_KIND_ENABLED(CK_RMS) && n->kind == CK_RMS) return 0; return eval_rms(s, n, sr);
    case CK_PEAK: if (!CRATE_KIND_ENABLED(CK_PEAK) && n->kind == CK_PEAK) return 0; return eval_peak(s, n, sr);
    case CK_ONSET: if (!CRATE_KIND_ENABLED(CK_ONSET) && n->kind == CK_ONSET) return 0; return eval_onset(s, n, sr);
    case CK_PITCH: if (!CRATE_KIND_ENABLED(CK_PITCH) && n->kind == CK_PITCH) return 0; return eval_pitch(s, n, sr);

    case CK_CLOCK: if (!CRATE_KIND_ENABLED(CK_CLOCK) && n->kind == CK_CLOCK) return 0; {
        crate_real freq = rmax(ev(s, n, CI_FREQ, sr), 0);
        m = memory_for(s, slot);
        if (!m) return 0;
        /* Phase starts at 1 so the first sample fires, and a reset puts it
         * back to 1: Play and the first tick are the same instant. */
        if (!m->initialized) { m->phase = 1; m->initialized = 1; }
        if (reset_rose(s, n, sr, m)) m->phase = 1;
        m->phase += freq / sr;
        if (m->phase >= 1) {
            m->phase -= R(floor)(m->phase);
            return 1;
        }
        return 0;
    }
    case CK_CLOCK_DIVIDE: if (!CRATE_KIND_ENABLED(CK_CLOCK_DIVIDE) && n->kind == CK_CLOCK_DIVIDE) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        crate_real factor = rmax(1, js_round(ev(s, n, CI_FACTOR, sr)));
        m = memory_for(s, slot);
        if (!m) return 0;
        /* One short of the factor, so the next tick through fires. */
        if (reset_rose(s, n, sr, m)) m->count = factor - 1;
        int rose = value > RL(0.5) && m->prev <= RL(0.5);
        m->prev = value;
        if (!rose) return 0;
        m->count += 1;
        if (m->count >= factor) {
            m->count = 0;
            return 1;
        }
        return 0;
    }
    case CK_CLOCK_MULTIPLY: if (!CRATE_KIND_ENABLED(CK_CLOCK_MULTIPLY) && n->kind == CK_CLOCK_MULTIPLY) return 0; return eval_clock_multiply(s, n, sr);
    case CK_LOGIC: if (!CRATE_KIND_ENABLED(CK_LOGIC) && n->kind == CK_LOGIC) return 0; {
        int mode = n->m;
        int a = ev(s, n, CI_A, sr) > RL(0.5);
        if (mode == 3) return a ? 0 : 1;
        int b = ev(s, n, CI_B, sr) > RL(0.5);
        if (mode == 1) return (a || b) ? 1 : 0;
        if (mode == 2) return a != b ? 1 : 0;
        return (a && b) ? 1 : 0;
    }
    case CK_FLIP_FLOP: if (!CRATE_KIND_ENABLED(CK_FLIP_FLOP) && n->kind == CK_FLIP_FLOP) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        m = memory_for(s, slot);
        if (!m) return 0;
        int rose = value > RL(0.5) && m->prev <= RL(0.5);
        m->prev = value;
        if (rose) m->on = m->on > RL(0.5) ? 0 : 1;
        return m->on;
    }
    case CK_QUANTIZE: if (!CRATE_KIND_ENABLED(CK_QUANTIZE) && n->kind == CK_QUANTIZE) return 0;
        return quantize_to_scale(ev(s, n, CI_INPUT, sr), ev(s, n, CI_ROOT, sr), ev(s, n, CI_SCALE, sr));
    case CK_EUCLIDEAN: if (!CRATE_KIND_ENABLED(CK_EUCLIDEAN) && n->kind == CK_EUCLIDEAN) return 0; return eval_euclidean(s, n, sr);
    case CK_RANDOM: if (!CRATE_KIND_ENABLED(CK_RANDOM) && n->kind == CK_RANDOM) return 0; return eval_random(s, n, sr);
    case CK_TRIGGER: if (!CRATE_KIND_ENABLED(CK_TRIGGER) && n->kind == CK_TRIGGER) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        crate_real threshold = ev(s, n, CI_THRESHOLD, sr);
        m = memory_for(s, slot);
        if (!m) return 0;
        int rose = value > threshold && m->prev <= threshold;
        m->prev = value;
        return rose ? 1 : 0;
    }
    case CK_PULSE: if (!CRATE_KIND_ENABLED(CK_PULSE) && n->kind == CK_PULSE) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        crate_real width_sec = rmax(ev(s, n, CI_WIDTH_SEC, sr), 0);
        m = memory_for(s, slot);
        if (!m) return 0;
        int rose = value > RL(0.5) && m->prev <= RL(0.5);
        m->prev = value;
        if (rose) m->left = rmax(1, js_round(width_sec * sr));
        if (m->left <= 0) return 0;
        m->left -= 1;
        return 1;
    }
    case CK_SEQUENCER: if (!CRATE_KIND_ENABLED(CK_SEQUENCER) && n->kind == CK_SEQUENCER) return 0; {
        crate_real clock_in = ev(s, n, CI_CLOCK, sr);
        m = memory_for(s, slot);
        if (!m) return 0;
        if (reset_rose(s, n, sr, m)) m->index = -1;
        int rose = clock_in > RL(0.5) && m->prev <= RL(0.5);
        m->prev = clock_in;
        if (n->list_count == 0) return 0;
        if (rose) m->index = wrap_mod(m->index + 1, (crate_real)n->list_count);
        if (m->index < 0) return 0;
        return eval(s, list_at(s, n, (int)m->index), sr);
    }
    case CK_SELECT: if (!CRATE_KIND_ENABLED(CK_SELECT) && n->kind == CK_SELECT) return 0; {
        crate_real a = ev(s, n, CI_A, sr);
        crate_real b = ev(s, n, CI_B, sr);
        crate_real which = ev(s, n, CI_WHICH, sr);
        return which > RL(0.5) ? b : a;
    }
    case CK_REVERSE: if (!CRATE_KIND_ENABLED(CK_REVERSE) && n->kind == CK_REVERSE) return 0; return eval_reverse(s, n, sr);
    case CK_LOOPER: if (!CRATE_KIND_ENABLED(CK_LOOPER) && n->kind == CK_LOOPER) return 0; return eval_looper(s, n, sr);
    case CK_DELAY: if (!CRATE_KIND_ENABLED(CK_DELAY) && n->kind == CK_DELAY) return 0; return eval_delay(s, n, sr);
    case CK_WAVETABLE: if (!CRATE_KIND_ENABLED(CK_WAVETABLE) && n->kind == CK_WAVETABLE) return 0; return eval_wavetable(s, n, sr);
    case CK_SAMPLE_PLAY: if (!CRATE_KIND_ENABLED(CK_SAMPLE_PLAY) && n->kind == CK_SAMPLE_PLAY) return 0; return eval_sample_play(s, n, sr);
    case CK_GRAIN: if (!CRATE_KIND_ENABLED(CK_GRAIN) && n->kind == CK_GRAIN) return 0; return eval_grain(s, n, sr);
    case CK_PITCH_SHIFT: if (!CRATE_KIND_ENABLED(CK_PITCH_SHIFT) && n->kind == CK_PITCH_SHIFT) return 0; return eval_pitch_shift(s, n, sr);
    case CK_PAN_LAW: if (!CRATE_KIND_ENABLED(CK_PAN_LAW) && n->kind == CK_PAN_LAW) return 0; {
        crate_real value = ev(s, n, CI_INPUT, sr);
        crate_real pan = rmin(1, rmax(-1, ev(s, n, CI_PAN, sr)));
        crate_real angle = ((pan + 1) * PI_R) / 4;
        return value * (n->m == 1 ? R(sin)(angle) : R(cos)(angle));
    }
    case CK_NOISE: if (!CRATE_KIND_ENABLED(CK_NOISE) && n->kind == CK_NOISE) return 0; return eval_noise(s, n, sr);
    case CK_TRANSPORT: if (!CRATE_KIND_ENABLED(CK_TRANSPORT) && n->kind == CK_TRANSPORT) return 0; return eval_transport(s, n, sr);
    case CK_KERNEL: if (!CRATE_KIND_ENABLED(CK_KERNEL) && n->kind == CK_KERNEL) return 0;
        /* Unbound. A source is only meaningful as the output, where
         * `crate_render` takes its fallback before the tree is walked; a
         * seam is a wire. */
        if (n->m != 0) return 0;
        return ev(s, n, CI_INPUT, sr);
    default:
        return 0;
    }
}

static crate_real eval(crate_state *s, int slot, crate_real sr) {
    if (s->stamps[slot] == s->generation) return s->values[slot];
    crate_real result = compute(s, slot, sr);
    s->values[slot] = result;
    s->stamps[slot] = s->generation;
    return result;
}

/* ---------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------ */

int crate_render(crate_state *s, double sample_rate, int frames,
                 float *out_l, float *out_r,
                 const float *in_l, const float *in_r,
                 const crate_transport *transport,
                 float *const *sends_l, float *const *sends_r) {
    const crate_plan *plan = s->plan;
    const crate_plan_header *h = plan->h;
    const crate_real sr = (crate_real)sample_rate;
    const int root = h->root;
    if (transport) {
        s->transport = *transport;
        s->has_transport = 1;
    }
    s->rendered_rate = sample_rate;

    const crate_node *root_node = &plan->nodes[root];
    if (root_node->kind == CK_KERNEL && root_node->m != 0) {
        /* An unbound source: an effect passes its signal through so a failed
         * load does not mute the track; an instrument is silent. */
        if (root_node->m == 2 || !in_l) {
            memset(out_l, 0, sizeof(float) * (size_t)frames);
            if (out_r) memset(out_r, 0, sizeof(float) * (size_t)frames);
        } else {
            memcpy(out_l, in_l, sizeof(float) * (size_t)frames);
            if (out_r) memcpy(out_r, in_r ? in_r : in_l, sizeof(float) * (size_t)frames);
        }
        commit_ramps(s, frames);
        return out_r != NULL;
    }

    if (in_l && plan->main_port >= 0) {
        s->port_l[plan->main_port] = in_l;
        s->port_r[plan->main_port] = in_r;
    }

    /* Nothing wired to a right channel anywhere: the second pass would be
     * the first computed again. */
    int all_mono = plan->mirrors_mono_input && in_r == NULL;
    for (int i = 0; all_mono && i < h->port_count; i++) {
        if (s->port_r[i]) all_mono = 0;
    }

    const float *scalar_input = (h->flags & CRATE_PF_READS_SCALAR_INPUT) ? in_l : NULL;
    const int main_port = plan->main_port;
    float *const *sl = h->send_count > 0 ? sends_l : NULL;
    const int stereo_pass = plan->stereo && !all_mono;
    float *const *sr_sends = stereo_pass && sl ? sends_r : NULL;
    const int wants_right = stereo_pass && (out_r != NULL || sr_sends != NULL);

    for (int i = 0; i < frames; i++) {
        s->frame = i;
        s->lane = 0;
        if (scalar_input && main_port >= 0) s->port_scalars[main_port] = (crate_real)scalar_input[i];
        s->generation += 1;
        out_l[i] = (float)eval(s, root, sr);
        if (sl) {
            for (int k = 0; k < h->send_count; k++) sl[k][i] = (float)s->values[plan->sends[k]];
        }
        if (wants_right) {
            /* A second full pass with its own node memory: a real stereo
             * filter, not a mono one copied to both sides. */
            s->lane = 1;
            s->generation += 1;
            float right = (float)eval(s, root, sr);
            if (out_r) out_r[i] = right;
            if (sr_sends) {
                for (int k = 0; k < h->send_count; k++) sr_sends[k][i] = (float)s->values[plan->sends[k]];
            }
        }
    }
    s->lane = 0;
    commit_ramps(s, frames);
    for (int i = 0; i < h->port_count; i++) {
        s->port_l[i] = NULL;
        s->port_r[i] = NULL;
    }
    return sl ? sr_sends != NULL : (wants_right && out_r != NULL);
}
