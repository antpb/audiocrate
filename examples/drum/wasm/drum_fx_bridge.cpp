// homecrate drum for the browser: the VST3 port's DrumEngine (which ports the
// AUv3's Swift voice and its C++ kernel) behind a handle, as the synth's
// bridge does. Pad samples arrive decoded, at their own rate, and are
// resampled to the session rate here exactly as the VST3 processor does.
#include <emscripten/emscripten.h>

#include <vector>

#include "../vst3/engine/DrumEngine.h"

namespace {
struct DrumFx {
    DrumEngine engine;
    int max_frames = 128;
    std::vector<float> out_l, out_r;
};
}

extern "C" {
EMSCRIPTEN_KEEPALIVE DrumFx *drumfx_create(double sample_rate, int max_frames) {
    auto *d = new DrumFx();
    d->max_frames = max_frames > 0 ? max_frames : 128;
    d->out_l.assign(d->max_frames, 0.f);
    d->out_r.assign(d->max_frames, 0.f);
    d->engine.initialize(sample_rate, static_cast<uint32_t>(d->max_frames));
    // The kit's default character IR, as the processor does when no user IR is set.
    d->engine.kernel().synthesizeDefaultMasterIR();
    return d;
}
EMSCRIPTEN_KEEPALIVE void drumfx_destroy(DrumFx *d) { delete d; }
EMSCRIPTEN_KEEPALIVE void drumfx_set_param(DrumFx *d, int address, float value) {
    d->engine.setParameter(static_cast<uint64_t>(address), value);
}
/* A decoded pad sample at `rate` Hz; `right` may be null (mono). */
EMSCRIPTEN_KEEPALIVE void drumfx_load_pad(DrumFx *d, int pad, const float *left, const float *right, int frames, double rate) {
    hcwav::WavDataStereo wav;
    wav.sampleRate = rate;
    wav.left.assign(left, left + frames);
    wav.right.assign(right ? right : left, (right ? right : left) + frames);
    hcwav::resampleStereo(wav, d->engine.sampleRate());
    d->engine.installPadSample(pad, std::move(wav.left), std::move(wav.right));
}
EMSCRIPTEN_KEEPALIVE void drumfx_note_on(DrumFx *d, int note, float velocity01) {
    if (velocity01 > 0.001f) d->engine.noteOn(note, velocity01);
}
EMSCRIPTEN_KEEPALIVE void drumfx_set_context(DrumFx *d, int valid, double beat, double tempo) {
    d->engine.setMusicalContext(valid != 0, beat, tempo);
}
EMSCRIPTEN_KEEPALIVE float *drumfx_buffer(DrumFx *d, int which) { return which == 0 ? d->out_l.data() : d->out_r.data(); }
EMSCRIPTEN_KEEPALIVE void drumfx_process(DrumFx *d, int frames) {
    if (frames > d->max_frames) frames = d->max_frames;
    // A stretch amount moved: re-stretch that pad (the processor queues this
    // on its loader thread; here it happens before the block, once).
    for (int pad = 0; pad < DrumEngine::kNumPads; ++pad)
        if (d->engine.stretchDirty(pad)) d->engine.recomputeStretch(pad);
    d->engine.render(d->out_l.data(), d->out_r.data(), frames);
}
}
