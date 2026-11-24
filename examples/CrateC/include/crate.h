/*
 * CrateC: the third ASL interpreter.
 *
 * `asl/compile.ts` is the reference and `examples/CrateASL` is the Swift
 * twin. This is the same interpreter in C99, written for a host with no
 * operating system to lean on: no allocation on the render path, no strings
 * hashed per sample, and a plan that can be read straight out of
 * memory-mapped flash.
 *
 * The plan is a single position-independent blob. A host tool builds it from
 * a graph document (`crate_build.h`), and the same bytes are what a device
 * loads, so there is one plan format rather than a JSON reader on each side.
 * A device never parses JSON.
 *
 * `crate_real` is the sample type the graph is evaluated in. The default is
 * double, which is what the conformance gate holds to the JavaScript and
 * Swift interpreters. Define CRATE_REAL_FLOAT to evaluate in float for a
 * target whose FPU is single precision, and measure the deviation that buys
 * with the same gate (`make conformance-float`).
 */
#ifndef CRATE_H
#define CRATE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifdef CRATE_REAL_FLOAT
typedef float crate_real;
#else
typedef double crate_real;
#endif

/*
 * Node kinds. The order is part of the plan format: a pack written by one
 * build is read by another, so a kind is only ever appended.
 */
enum crate_kind {
    CK_CONST, CK_PARAM, CK_PORT, CK_LANE, CK_METER, CK_CAPTURE,
    CK_OSC, CK_LFO, CK_ADSR, CK_MIX, CK_MUL, CK_ADD, CK_TO_FREQUENCY, CK_RANGE,
    CK_FILTER_LOWPASS, CK_FILTER_HIGHPASS, CK_FILTER_BANDPASS, CK_FILTER_NOTCH,
    CK_FILTER_PEAKING, CK_FILTER_LOW_SHELF, CK_FILTER_HIGH_SHELF, CK_FILTER_ALLPASS,
    CK_ONE_POLE_LOWPASS, CK_ONE_POLE_HIGHPASS, CK_SVF, CK_LADDER, CK_COMB,
    CK_BITCRUSH, CK_DOWNSAMPLE, CK_RECTIFY, CK_SLEW, CK_SAMPLE_HOLD, CK_COMPARE, CK_COMPRESSOR,
    CK_CLOCK, CK_CLOCK_DIVIDE, CK_CLOCK_MULTIPLY, CK_LOGIC, CK_FLIP_FLOP, CK_QUANTIZE,
    CK_EUCLIDEAN, CK_RANDOM, CK_TRIGGER, CK_PULSE, CK_DAHDSR, CK_SEQUENCER, CK_IMPULSE,
    CK_EXPANDER, CK_TRANSIENT, CK_REVERSE, CK_LOOPER, CK_SELECT, CK_WAVESHAPE, CK_BREAKPOINTS,
    CK_RMS, CK_PEAK, CK_ONSET, CK_PITCH, CK_FILTER_SLOPE, CK_WAVETABLE, CK_SAMPLE_PLAY, CK_GRAIN,
    CK_PITCH_SHIFT, CK_PAN_LAW, CK_NOISE, CK_DELAY, CK_CLIP, CK_DC_BLOCK, CK_ENV_FOLLOW,
    CK_TRANSPORT, CK_KERNEL,
    CK_COUNT
};

/* The document spelling of each kind, indexed by `enum crate_kind`. */
extern const char *const crate_kind_names[CK_COUNT];

/*
 * Every input name any ASL builder wires. A plan node holds one child index
 * per name, so an input read is an array index with no string anywhere.
 */
enum crate_input {
    CI_INPUT, CI_A, CI_B, CI_ATTACK, CI_BITS, CI_CLOCK, CI_CUTOFF, CI_DECAY, CI_DELAY, CI_DRIVE,
    CI_DURATION, CI_FACTOR, CI_FALL, CI_FEEDBACK, CI_FREQ, CI_GAIN_DB, CI_GATE, CI_HITS, CI_HOLD,
    CI_INDEX, CI_LENGTH, CI_MIX, CI_NOTE, CI_PAN, CI_PHASE, CI_PITCH, CI_POSITION, CI_Q, CI_RATE,
    CI_RATIO, CI_RECORD, CI_RELEASE, CI_RESET, CI_RESONANCE, CI_RISE, CI_ROOT, CI_ROTATION,
    CI_SCALE, CI_SIDECHAIN, CI_SOURCE, CI_STEPS, CI_SUSTAIN, CI_THRESHOLD, CI_TIME_SEC, CI_TRIG,
    CI_TRIGGER, CI_WHICH, CI_WIDTH, CI_WIDTH_SEC, CI_WINDOW_SEC, CI_TYPE, CI_COLOR,
    CI_COUNT
};

extern const char *const crate_input_names[CI_COUNT];

/* ---------------------------------------------------------------------------
 * The plan blob
 *
 * Everything is an offset from the start of the blob, so the bytes can sit
 * anywhere: a heap buffer on a desktop, a const array linked into firmware,
 * or a region of flash the CPU executes in place. Pools are 8-byte aligned
 * so a double never straddles a word on a core that faults on that.
 * ------------------------------------------------------------------------ */

#define CRATE_PLAN_MAGIC 0x4C505243u /* "CRPL" little endian */
#define CRATE_PLAN_VERSION 1
#define CRATE_NONE 0xFFFFu

enum crate_plan_flags {
    CRATE_PF_USES_LANE = 1,
    CRATE_PF_USES_RANDOM = 2,
    CRATE_PF_READS_SCALAR_INPUT = 4
};

typedef struct crate_node {
    uint8_t kind;
    /* A mode, shape, colour or field resolved to an integer (`planMode`).
     * A port's fixed channel, or -1 to follow the channel being rendered. */
    int8_t m;
    /* A param's index into the param names, a port's into the port names,
     * a tap's into the tap ids, or a noise/random node's rank. CRATE_NONE
     * for every other kind. */
    uint16_t ix;
    uint16_t list_count;
    uint16_t a_len;
    uint16_t b_len;
    uint16_t pad0;
    uint32_t list_off;  /* int16 node indices in the index pool */
    uint32_t a_off;     /* doubles in the number pool */
    uint32_t b_off;
    uint32_t table_off; /* floats in the table pool */
    uint32_t table_len;
    uint32_t pad1;
    double c;           /* `planConst`: max delay, window size, pole count */
    double range_min;
    double range_max;
    double box_rate;    /* a sample box's source rate, 0 to follow the render */
    int16_t in[CI_COUNT]; /* child node index per input name, -1 when absent */
} crate_node;

typedef struct crate_plan_header {
    uint32_t magic;
    uint16_t version;
    uint16_t node_count;
    uint32_t size;          /* the whole blob, bus included */
    uint16_t root;
    int8_t channels;        /* 0: decide from the graph, else 1 or 2 */
    uint8_t flags;
    uint16_t param_count;
    uint16_t port_count;
    uint16_t tap_count;
    uint16_t send_count;
    uint16_t smooth_count;
    uint16_t main_port;     /* index of the port named "input", or CRATE_NONE */
    uint32_t nodes_off;
    uint32_t index_off;
    uint32_t number_off;
    uint32_t table_off;
    uint32_t string_off;
    uint32_t params_off;    /* uint32 string offsets, sorted by name */
    uint32_t ports_off;     /* uint32 string offsets, sorted by name */
    uint32_t taps_off;      /* uint32 string offsets, sorted by id */
    uint32_t tap_windows_off; /* uint32 ring size per tap, 0 for a meter */
    uint32_t sends_off;     /* uint16 node index per send */
    uint32_t smooth_off;    /* uint16 param index per smoothed param */
    uint32_t bus_off;       /* a nested plan blob, 0 for none */
    uint32_t pad;
} crate_plan_header;

/* A validated view of a blob. Holds pointers into it and nothing else. */
typedef struct crate_plan {
    const crate_plan_header *h;
    const crate_node *nodes;
    const int16_t *index;
    const double *numbers;
    const float *tables;
    const char *strings;
    const uint32_t *params;
    const uint32_t *ports;
    const uint32_t *taps;
    const uint32_t *tap_windows;
    const uint16_t *sends;
    const uint16_t *smooth;
    const void *bus_blob;
    int stereo;
    int mirrors_mono_input;
    int main_port;          /* -1 when the graph reads no "input" port */
} crate_plan;

/* Returns 0 on success. Rejects a blob that is truncated, from another
 * version, or whose offsets point outside it. */
int crate_plan_open(crate_plan *plan, const void *blob, size_t size);

const char *crate_plan_param_name(const crate_plan *plan, int index);
const char *crate_plan_port_name(const crate_plan *plan, int index);
int crate_plan_param_index(const crate_plan *plan, const char *name);
int crate_plan_port_index(const crate_plan *plan, const char *name);

/* ---------------------------------------------------------------------------
 * Memory
 *
 * Every byte a voice uses comes out of an arena the host hands over: a bump
 * allocator with no free. Node memory and delay lines are taken the first
 * time a node runs, which on a render thread is a pointer increment and
 * nothing else. `crate_state_prepare` takes all of it up front instead, which
 * is what a device wants so that the first note costs the same as the
 * hundredth, and what a pack builder runs to learn a patch's footprint.
 * ------------------------------------------------------------------------ */

typedef struct crate_arena {
    uint8_t *base;
    size_t cap;
    size_t used;
} crate_arena;

void crate_arena_init(crate_arena *arena, void *memory, size_t bytes);
void *crate_arena_alloc(crate_arena *arena, size_t bytes);

/* ---------------------------------------------------------------------------
 * Voice state
 * ------------------------------------------------------------------------ */

typedef struct crate_transport {
    double beats;
    double bpm;
    int playing;
    double beats_per_bar;
    double beat_unit;
} crate_transport;

void crate_transport_default(crate_transport *t);

typedef struct crate_mem crate_mem;

typedef struct crate_state {
    const crate_plan *plan;
    crate_arena *arena;
    crate_real *values;
    uint32_t *stamps;
    uint32_t generation;
    int frame;
    int lane;
    int gate;
    crate_mem **mem[2];
    crate_real *param_values;
    crate_real *ramp_step;
    crate_real *ramp_target;
    int32_t *ramp_frames;
    uint8_t *param_set;
    int has_ramps;
    crate_real *port_scalars;
    const float **port_l;
    const float **port_r;
    crate_transport transport;
    int has_transport;
    double rendered_rate;
    uint32_t seed;
    /* Set when the arena ran dry: some node rendered without the memory it
     * asked for, and is passing its input through or reading silence. */
    int starved;
    crate_real *tap_peak;
    crate_real *tap_sum_sq;
    crate_real *tap_count;
} crate_state;

/* Returns 0 on success, -1 when the arena cannot hold the fixed part. */
int crate_state_init(crate_state *state, const crate_plan *plan, crate_arena *arena, uint32_t seed);

/* Takes every node's memory and every fixed-size buffer now, for both
 * channels of a stereo graph. Returns 0, or -1 if the arena ran out. */
int crate_state_prepare(crate_state *state, double sample_rate);
/* The same for the first `lanes` channels only. A host that will only ever
 * hand a mirrorable graph mono input never renders its second lane, so it
 * need not hold that lane's delay lines; one that does reach it later gets
 * them lazily, as an unprepared state would. */
int crate_state_prepare_lanes(crate_state *state, double sample_rate, int lanes);

/* A parameter, set at once, cancelling any ramp on it. Also writes the
 * scalar of a port with the same name, which is how a graph written against
 * the old scalar `input` keeps working. Host thread, never per sample. */
void crate_set_param(crate_state *state, const char *name, double value);
void crate_set_param_index(crate_state *state, int index, double value);
/* Ramps to `value` over `frames`, from frame 0 of the next render. */
void crate_ramp_param(crate_state *state, const char *name, double value, int frames);
/* A host's change: glides when the graph lists the parameter in `smooth`
 * and the voice has rendered, lands at once otherwise. `setParam` in
 * compile.ts. */
void crate_glide_param(crate_state *state, const char *name, double value);
/* The same by param index, for the render thread: no string compared. A
 * glided param does not also write a port scalar; only `crate_set_param`
 * keeps the two in step. */
void crate_glide_param_index(crate_state *state, int index, double value);

/*
 * Renders one block. Returns whether `out_r` (or the right sends) was
 * written; a caller that gets 0 mirrors channel 0 itself.
 *
 * `sends_l` / `sends_r` are a split instrument's voice outputs, one buffer
 * per send, and only a voice pool passes them.
 */
int crate_render(crate_state *state, double sample_rate, int frames,
                 float *out_l, float *out_r,
                 const float *in_l, const float *in_r,
                 const crate_transport *transport,
                 float *const *sends_l, float *const *sends_r);

/* Wires an auxiliary port for the coming block. Cleared when it returns. */
void crate_set_port(crate_state *state, int index, const float *left, const float *right);

/* The seed a voice gets when nobody chooses one, `DEFAULT_VOICE_SEED`. */
#define CRATE_DEFAULT_SEED 0u
/* `PARAM_RAMP_SECONDS` in compile.ts. */
#define CRATE_PARAM_RAMP_SECONDS 0.005
int crate_param_ramp_frames(double sample_rate);

#ifdef __cplusplus
}
#endif

#endif
