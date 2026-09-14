//
//  homecrate_drumDSPKernel.mm
//  homecrate drum
//
//  Per-pad bitcrush + filter and master filter + IR character.
//

#import "homecrate_drumDSPKernel.h"
#import "BitCrusher.h"
#import "SVFilter.h"
#import "CascadeFilter.h"
#import "IRConvolver.h"

#include <array>
#include <vector>
#include <atomic>
#include <cstring>

namespace {
    constexpr int kNumPads        = 16;

    constexpr AUParameterAddress kPadSRateBase = 32;
    constexpr AUParameterAddress kPadBitsBase  = 48;
    constexpr AUParameterAddress kPadCutBase   = 64;
    constexpr AUParameterAddress kPadResBase   = 80;
    constexpr AUParameterAddress kMasterCut    = 96;
    constexpr AUParameterAddress kMasterRes    = 97;
    constexpr AUParameterAddress kMasterIRMix  = 98;
    constexpr AUParameterAddress kMasterBypass = 99;
    constexpr AUParameterAddress kMasterVol    = 100;

    // Default IR synthesis
    constexpr int kDefaultIRLength = 1024;
    constexpr int kIRPartSize      = 512;
}

struct homecrate_drumDSPKernel::Impl {
    double sampleRate = 48000.0;
    AUAudioFrameCount maxFrames = 4096;

    // Per-pad params (cached float values driven by the parameter tree)
    std::array<float, kNumPads> padSRate;
    std::array<float, kNumPads> padBits;
    std::array<float, kNumPads> padCut;
    std::array<float, kNumPads> padRes;

    // Per-pad stereo DSP — L and R kept independent so stereo samples retain image
    std::array<BitCrusher, kNumPads> crusherL;
    std::array<BitCrusher, kNumPads> crusherR;
    std::array<SVFilter,   kNumPads> filterL;
    std::array<SVFilter,   kNumPads> filterR;

    // Master
    float masterCut    = 20000.0f;
    float masterRes    = 0.0f;
    float masterIRMix  = 0.0f;
    float masterVol    = 1.0f;
    std::atomic<bool> bypassPadDSP{false};

    CascadeFilter masterFiltL;
    CascadeFilter masterFiltR;

    IRConvolver irL;
    IRConvolver irR;
    std::atomic<bool> irActive{false};   // whether to run the IR pass at all

    // Scratch buffers — sized to maxFrames, used by master dry/wet mix
    std::vector<float> scratchL;
    std::vector<float> scratchR;

    Impl() {
        padSRate.fill(1.0f);
        padBits.fill(16.0f);
        padCut.fill(20000.0f);
        padRes.fill(0.0f);
    }
};

// ── ctor / dtor / move ───────────────────────────────────────────────────────

homecrate_drumDSPKernel::homecrate_drumDSPKernel() : pImpl(new Impl()) {}

homecrate_drumDSPKernel::~homecrate_drumDSPKernel() {
    delete pImpl;
    pImpl = nullptr;
}

homecrate_drumDSPKernel::homecrate_drumDSPKernel(homecrate_drumDSPKernel&& o) noexcept
    : pImpl(o.pImpl) {
    o.pImpl = nullptr;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

void homecrate_drumDSPKernel::initialize(double sampleRate, AUAudioFrameCount maxFrames) {
    if (!pImpl) return;
    pImpl->sampleRate = sampleRate;
    pImpl->maxFrames  = maxFrames;

    for (int i = 0; i < kNumPads; ++i) {
        pImpl->crusherL[i].init();
        pImpl->crusherR[i].init();
        pImpl->filterL[i].init(sampleRate);
        pImpl->filterR[i].init(sampleRate);
        pImpl->filterL[i].setType(SVFilter::LowPass);
        pImpl->filterR[i].setType(SVFilter::LowPass);
        pImpl->filterL[i].setCutoff(pImpl->padCut[i]);
        pImpl->filterR[i].setCutoff(pImpl->padCut[i]);
        pImpl->filterL[i].setResonance(pImpl->padRes[i]);
        pImpl->filterR[i].setResonance(pImpl->padRes[i]);
    }

    pImpl->masterFiltL.init(sampleRate);
    pImpl->masterFiltR.init(sampleRate);
    pImpl->masterFiltL.setOrder(3);   // 18 dB/oct — smooth core
    pImpl->masterFiltR.setOrder(3);
    pImpl->masterFiltL.setType(CascadeFilter::LowPass);
    pImpl->masterFiltR.setType(CascadeFilter::LowPass);
    pImpl->masterFiltL.setCutoff(pImpl->masterCut);
    pImpl->masterFiltR.setCutoff(pImpl->masterCut);
    pImpl->masterFiltL.setResonance(pImpl->masterRes);
    pImpl->masterFiltR.setResonance(pImpl->masterRes);

    pImpl->scratchL.assign(maxFrames, 0.0f);
    pImpl->scratchR.assign(maxFrames, 0.0f);
}

void homecrate_drumDSPKernel::deInitialize() {
    if (!pImpl) return;
    pImpl->irActive.store(false);
    pImpl->scratchL.clear();
    pImpl->scratchR.clear();
}

// ── parameter routing ────────────────────────────────────────────────────────

void homecrate_drumDSPKernel::setParameter(AUParameterAddress address, AUValue value) {
    if (!pImpl) return;

    if (address >= kPadSRateBase && address < kPadSRateBase + kNumPads) {
        int i = static_cast<int>(address - kPadSRateBase);
        pImpl->padSRate[i] = value;
        return;
    }
    if (address >= kPadBitsBase && address < kPadBitsBase + kNumPads) {
        int i = static_cast<int>(address - kPadBitsBase);
        pImpl->padBits[i] = value;
        return;
    }
    if (address >= kPadCutBase && address < kPadCutBase + kNumPads) {
        int i = static_cast<int>(address - kPadCutBase);
        pImpl->padCut[i] = value;
        pImpl->filterL[i].setCutoff(value);
        pImpl->filterR[i].setCutoff(value);
        return;
    }
    if (address >= kPadResBase && address < kPadResBase + kNumPads) {
        int i = static_cast<int>(address - kPadResBase);
        pImpl->padRes[i] = value;
        pImpl->filterL[i].setResonance(value);
        pImpl->filterR[i].setResonance(value);
        return;
    }

    switch (address) {
        case kMasterCut:
            pImpl->masterCut = value;
            pImpl->masterFiltL.setCutoff(value);
            pImpl->masterFiltR.setCutoff(value);
            break;
        case kMasterRes:
            pImpl->masterRes = value;
            pImpl->masterFiltL.setResonance(value);
            pImpl->masterFiltR.setResonance(value);
            break;
        case kMasterIRMix:
            pImpl->masterIRMix = value;
            break;
        case kMasterBypass:
            pImpl->bypassPadDSP.store(value >= 0.5f);
            break;
        case kMasterVol:
            pImpl->masterVol = value;
            break;
        default: break;
    }
}

void homecrate_drumDSPKernel::setBypassPadDSP(bool bypass) {
    if (pImpl) pImpl->bypassPadDSP.store(bypass);
}

bool homecrate_drumDSPKernel::isBypassPadDSP() const {
    return pImpl && pImpl->bypassPadDSP.load();
}

// ── IR loading ───────────────────────────────────────────────────────────────

void homecrate_drumDSPKernel::synthesizeDefaultMasterIR() {
    if (!pImpl) return;

    // Run a unit impulse through a designed LPF chain to produce our default
    // character. 18 dB/oct Butterworth at ~17 kHz with a modest Q to add a
    // gentle pre-cutoff bump (the "026S edge"). Coefficients are ours; nothing
    // is sampled from real hardware.
    std::vector<float> impulse(kDefaultIRLength, 0.0f);
    impulse[0] = 1.0f;

    CascadeFilter designer;
    designer.init(pImpl->sampleRate);
    designer.setOrder(3);
    designer.setType(CascadeFilter::LowPass);
    designer.setCutoff(17000.0f);
    designer.setResonance(0.18f);

    for (int i = 0; i < kDefaultIRLength; ++i) {
        impulse[i] = designer.process(impulse[i]);
    }

    pImpl->irActive.store(false);
    pImpl->irL.setup(impulse.data(), kDefaultIRLength, kIRPartSize);
    pImpl->irR.setup(impulse.data(), kDefaultIRLength, kIRPartSize);
    pImpl->irL.reset();
    pImpl->irR.reset();
    pImpl->irActive.store(pImpl->irL.isReady() && pImpl->irR.isReady());
}

void homecrate_drumDSPKernel::setUserMasterIR(const float* samples, int sampleCount) {
    if (!pImpl || samples == nullptr || sampleCount <= 0) return;
    pImpl->irActive.store(false);
    pImpl->irL.setup(samples, sampleCount, kIRPartSize);
    pImpl->irR.setup(samples, sampleCount, kIRPartSize);
    pImpl->irL.reset();
    pImpl->irR.reset();
    pImpl->irActive.store(pImpl->irL.isReady() && pImpl->irR.isReady());
}

void homecrate_drumDSPKernel::clearMasterIR() {
    if (!pImpl) return;
    pImpl->irActive.store(false);
    pImpl->irL.reset();
    pImpl->irR.reset();
}

// ── per-render-call surface ──────────────────────────────────────────────────

void homecrate_drumDSPKernel::processPadInPlace(int padIdx, float* samplesL, float* samplesR, int frames) {
    if (!pImpl || frames <= 0) return;
    if (padIdx < 0 || padIdx >= kNumPads) return;
    if (pImpl->bypassPadDSP.load()) return;

    // BitCrusher (mono, in-place). Per-pad mix is always 1.0 — pad knobs
    // control the actual values directly.
    //
    // Apply a logarithmic curve to the sampleRate parameter so the full 0..1
    // UI range covers a perceptually useful span (~1 kHz → native SR). The raw
    // linear mapping puts the audible lo-fi zone below 0.3 and leaves the top
    // half of the knob nearly inaudible — the log curve fixes that.
    //   param=0.0 → ~1 kHz  (extreme lo-fi)
    //   param=0.5 → ~7 kHz  (clearly audible character)
    //   param=0.8 → ~25 kHz (subtle warmth)
    //   param=1.0 → native  (clean bypass)
    const float kLoSR = 1000.0f;
    const float srRatio = kLoSR / static_cast<float>(pImpl->sampleRate);  // e.g. 1000/48000 ≈ 0.0208
    const float srParam = pImpl->padSRate[padIdx];
    // pow(srRatio, 1-param): at param=1 → pow(x,0)=1.0; at param=0 → pow(x,1)=srRatio
    const float srCurved = (srParam >= 0.999f) ? 1.0f : powf(srRatio, 1.0f - srParam);
    pImpl->crusherL[padIdx].process(samplesL, frames, 1.0f, pImpl->padBits[padIdx], srCurved);
    pImpl->crusherR[padIdx].process(samplesR, frames, 1.0f, pImpl->padBits[padIdx], srCurved);

    // At ≤ 8-bit (harsh/Game Boy mode) truncation creates an asymmetric negative
    // DC bias and the raw S&H at low sample rates produces long rectangular runs
    // that sit near –1.0, which can overdrive downstream processing. Apply a
    // gentle gain trim that scales linearly from –2.5 dB at 4-bit to 0 dB at
    // 8-bit so the lo-fi character stays intact but the output stays practical.
    const float bits = pImpl->padBits[padIdx];
    if (bits < 8.0f) {
        const float norm = 0.75f + (bits - 4.0f) * (0.25f / 4.0f);  // 0.75 @ 4-bit → 1.0 @ 8-bit
        for (int i = 0; i < frames; ++i) {
            samplesL[i] *= norm;
            samplesR[i] *= norm;
        }
    }

    // Per-pad LPF
    SVFilter& fL = pImpl->filterL[padIdx];
    SVFilter& fR = pImpl->filterR[padIdx];
    for (int i = 0; i < frames; ++i) {
        samplesL[i] = fL.process(samplesL[i]);
        samplesR[i] = fR.process(samplesR[i]);
    }
}

void homecrate_drumDSPKernel::processMasterBus(float* outL, float* outR, int frames, bool busActive) {
    if (!pImpl || frames <= 0) return;

    // Master filter always runs — its state must stay coherent across silent
    // and active blocks so it doesn't pop on the next hit.
    CascadeFilter& mL = pImpl->masterFiltL;
    CascadeFilter& mR = pImpl->masterFiltR;
    for (int i = 0; i < frames; ++i) {
        outL[i] = mL.process(outL[i]);
        outR[i] = mR.process(outR[i]);
    }

    // IR — skip entirely when no IR is loaded or the mix is zero.
    bool irRan = false;
    if (pImpl->irActive.load()) {
        const float mix = pImpl->masterIRMix;
        if (mix >= 1e-4f) {
            const int n = (frames > static_cast<int>(pImpl->scratchL.size()))
                          ? static_cast<int>(pImpl->scratchL.size())
                          : frames;

            // Snapshot dry signal
            std::memcpy(pImpl->scratchL.data(), outL, n * sizeof(float));
            std::memcpy(pImpl->scratchR.data(), outR, n * sizeof(float));

            // Convolve in place (process allows input == output)
            pImpl->irL.process(outL, outL, n);
            pImpl->irR.process(outR, outR, n);

            // Dry/wet mix
            const float dryGain = 1.0f - mix;
            for (int i = 0; i < n; ++i) {
                outL[i] = pImpl->scratchL[i] * dryGain + outL[i] * mix;
                outR[i] = pImpl->scratchR[i] * dryGain + outR[i] * mix;
            }
            irRan = true;
        }
    }
    (void)irRan;

    // Master output gain — applied last so it always covers the full
    // processed buffer (filter + optional IR mix). At unity (1.0) we
    // skip the multiply to save a pass.
    const float g = pImpl->masterVol;
    if (g < 0.999f || g > 1.001f) {
        for (int i = 0; i < frames; ++i) {
            outL[i] *= g;
            outR[i] *= g;
        }
    }

    (void)busActive;  // reserved for future "tail-flush after silence" optimization
}
