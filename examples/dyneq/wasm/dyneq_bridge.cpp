// The dynEQ kernel for the browser: a handle per voice, buffers in the
// module's memory, the bus level passed with each block.
#include <cstdlib>
#include <emscripten/emscripten.h>

#include "../dsp/dyneq_kernel.h"

struct Handle {
    hcdyneq::Kernel kernel;
    int max_frames;
    float *in_l, *in_r, *out_l, *out_r;
    explicit Handle(double sr, int frames) : kernel(sr), max_frames(frames) {
        in_l = static_cast<float *>(calloc(frames, sizeof(float)));
        in_r = static_cast<float *>(calloc(frames, sizeof(float)));
        out_l = static_cast<float *>(calloc(frames, sizeof(float)));
        out_r = static_cast<float *>(calloc(frames, sizeof(float)));
    }
    ~Handle() { free(in_l); free(in_r); free(out_l); free(out_r); }
};

extern "C" {
EMSCRIPTEN_KEEPALIVE Handle *dyneq_create(double sample_rate, int max_frames) {
    return new Handle(sample_rate, max_frames > 0 ? max_frames : 128);
}
EMSCRIPTEN_KEEPALIVE void dyneq_destroy(Handle *h) { delete h; }
EMSCRIPTEN_KEEPALIVE void dyneq_set_param(Handle *h, int address, float value) { h->kernel.setParameter(address, value); }
/* 0 in_l, 1 in_r, 2 out_l, 3 out_r */
EMSCRIPTEN_KEEPALIVE float *dyneq_buffer(Handle *h, int which) {
    return which == 0 ? h->in_l : which == 1 ? h->in_r : which == 2 ? h->out_l : h->out_r;
}
EMSCRIPTEN_KEEPALIVE void dyneq_process(Handle *h, int frames, int stereo_in, float bus) {
    if (frames > h->max_frames) frames = h->max_frames;
    h->kernel.process(h->in_l, stereo_in ? h->in_r : nullptr, h->out_l, h->out_r, frames, bus);
}
EMSCRIPTEN_KEEPALIVE float dyneq_follower(Handle *h) { return h->kernel.followerLevel(); }
EMSCRIPTEN_KEEPALIVE float dyneq_gain_reduction(Handle *h) { return h->kernel.gainReduction(); }
}
