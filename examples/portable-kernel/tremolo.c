/*
 * A complete crate portable kernel, ABI version 1, in freestanding C.
 *
 * The DSP is deliberately boring: a tremolo, one LFO and one multiply. What
 * is worth studying is everything around it, because that is what "portable"
 * costs. There is no libc here, no malloc, no math.h, and no imports at all.
 * A worklet cannot load code, so it loads bytes, and bytes that ask the host
 * for anything are bytes the host has to be willing to provide.
 *
 * Build:  ./build.sh          Test:  test/renderers/kernels/portableKernel.example.test.ts
 * Docs:   ../../docs/kernels.md
 */

/* One page of frames is more than any renderer asks for in a block. Static,
 * because there is no allocator and because a kernel that cannot allocate on
 * the audio thread is a kernel that cannot stall on it either. */
#define MAX_FRAMES 1024

/* The handle crate_init hands back. Any nonzero value works; zero is reserved
 * for "I refuse to start".*/
#define HANDLE 1

#define EXPORT(name) __attribute__((export_name(#name)))

typedef struct {
    /* The blocks crate writes into and reads out of. Their addresses are what
     * crate_input_ptr and crate_output_ptr return. */
    float in[MAX_FRAMES];
    float out[MAX_FRAMES];

    float sampleRate;
    int   maxFrames;

    /* Parameters, in the units the Material declares. The descriptor maps
     * names to the ids used here; this module never sees a name. */
    float rateHz;    /* id 0 */
    float depth;     /* id 1 */

    float phase;     /* 0..1, one LFO cycle */
} Kernel;

static Kernel g;

/*
 * sin(2*pi*phase), approximately, because there is no math library and
 * linking one would stop this being freestanding.
 *
 * A parabola through the same zero crossings and peaks. Off by about one
 * percent, which is inaudible in a gain modulator and would not be acceptable
 * in an oscillator. Knowing which of those you are writing is most of the
 * skill in this constraint.
 */
static float sine_turns(float phase) {
    float x = phase * 2.0f - 1.0f;          /* -1 .. 1 */
    float a = x < 0.0f ? -x : x;
    return x * (1.0f - a) * 4.0f;
}

EXPORT(crate_abi_version)
int crate_abi_version(void) {
    return 1;
}

EXPORT(crate_init)
int crate_init(int sampleRate, int maxFrames) {
    /* Refusing is better than clamping. A host that asked for blocks bigger
     * than this module can hold would otherwise get the first 1024 frames of
     * every block processed and the rest passed through, which sounds like a
     * subtle bug rather than a loud one. */
    if (maxFrames <= 0 || maxFrames > MAX_FRAMES) return 0;
    if (sampleRate <= 0) return 0;

    g.sampleRate = (float)sampleRate;
    g.maxFrames = maxFrames;
    g.rateHz = 5.0f;
    g.depth = 0.5f;
    g.phase = 0.0f;

    for (int i = 0; i < MAX_FRAMES; i++) {
        g.in[i] = 0.0f;
        g.out[i] = 0.0f;
    }
    return HANDLE;
}

EXPORT(crate_input_ptr)
int crate_input_ptr(int handle, int channel) {
    /* Zero means "no such channel", which is how a mono kernel says so. It is
     * also why a buffer may never live at offset zero. */
    if (handle != HANDLE || channel != 0) return 0;
    return (int)(__UINTPTR_TYPE__)&g.in[0];
}

EXPORT(crate_output_ptr)
int crate_output_ptr(int handle, int channel) {
    if (handle != HANDLE || channel != 0) return 0;
    return (int)(__UINTPTR_TYPE__)&g.out[0];
}

EXPORT(crate_set_param)
void crate_set_param(int handle, int id, float value) {
    if (handle != HANDLE) return;
    switch (id) {
        case 0: g.rateHz = value < 0.0f ? 0.0f : value; break;
        case 1: g.depth = value < 0.0f ? 0.0f : (value > 1.0f ? 1.0f : value); break;
        default: break;   /* An unknown id is a host newer than this module. */
    }
}

EXPORT(crate_process)
void crate_process(int handle, int frames) {
    if (handle != HANDLE) return;
    if (frames > g.maxFrames) frames = g.maxFrames;

    const float step = g.rateHz / g.sampleRate;
    for (int i = 0; i < frames; i++) {
        /* 1 at the LFO peak, 1 - depth at the trough: full depth reaches
         * silence and zero depth is exact unity, so a bypassed tremolo is
         * bit-identical to no tremolo rather than nearly so. */
        const float lfo = 0.5f - 0.5f * sine_turns(g.phase);
        g.out[i] = g.in[i] * (1.0f - g.depth * lfo);

        g.phase += step;
        if (g.phase >= 1.0f) g.phase -= 1.0f;
    }
}

EXPORT(crate_latency)
int crate_latency(int handle) {
    (void)handle;
    return 0;   /* Sample by sample, nothing buffered. */
}
