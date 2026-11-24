// hc_dynEQ's DSP, portable: the iOS kernel (crate-engine-version/ios/
// homecrate dyneq/DSP/homecrate_dyneqDSPKernel.mm) with its math verbatim and
// its platform layer removed (os_unfair_lock, os_log, mach timing, the
// process-global EnvelopeBus). The bus level arrives as an argument to
// process(): the host owns the bus (in the browser, a global in the worklet
// realm that every hc_send voice publishes to).
//
// Chain: in x inputGain -> [comp if PRE] -> 5-band duck EQ -> [comp if POST]
// -> fade-in -> clamp x outputGain. TRUE stereo, stereo-linked compressor.
//
// Keep in step with the .mm: when its DSP changes, change it here.
#pragma once

#include <array>

namespace hcdyneq {

// Parameter addresses, as homecrate_dyneqParameterAddresses.h.
enum Address {
    inputGain = 0,
    outputGain = 1,
    eqBand0 = 10, eqBand1, eqBand2, eqBand3, eqBand4,
    duckDepth0 = 20, duckDepth1, duckDepth2, duckDepth3, duckDepth4,
    duckAttack = 30,
    duckRelease = 31,
    compThresh = 40,
    compRatio = 41,
    compAttack = 42,
    compRelease = 43,
    compMakeup = 44,
    compKey = 45,
    compPlacement = 46,
    dyneqBusIndex = 50,
};

class Kernel {
public:
    explicit Kernel(double sampleRate);

    void setParameter(int address, float value);
    // `bus` is the raw external level this block (max over live senders).
    // in_r / out_r may be null for mono.
    void process(const float *in_l, const float *in_r, float *out_l, float *out_r, int n, float bus);

    float followerLevel() const { return mFollower; }
    float gainReduction() const { return mGR; }

private:
    static constexpr int kEQBands = 5;
    struct BiquadCoeffs { double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0; };
    struct BiquadState  { double x1 = 0, x2 = 0, y1 = 0, y2 = 0; };

    void recomputeEQCoeffs(float follower);
    void applyEQ(float *buf, int n, int ch);
    void recomputeCompCoeffs();
    void runComp(float *chL, float *chR, int n);

    double mSampleRate;
    int mFadeInSamples = 1024;
    int mFadeInRemaining = 1024;

    float mInputGain = 1.f;
    float mOutputGain = 1.f;
    std::array<float, kEQBands> mEQGainDB = {};
    std::array<float, kEQBands> mDuckDepthDB = {};
    std::array<BiquadCoeffs, kEQBands> mEQCoeffs = {};
    std::array<BiquadState, kEQBands> mEQState = {};
    std::array<BiquadState, kEQBands> mEQStateR = {};
    bool mEQDirty = true;

    float mDuckAtkMs = 5.f;
    float mDuckRelMs = 120.f;
    float mCompThreshDB = 0.f;
    float mCompRatio = 4.f;
    float mCompAtkMs = 5.f;
    float mCompRelMs = 120.f;
    float mCompMakeupDB = 0.f;
    int mCompKey = 0;
    int mCompPlacement = 1;
    bool mDynDirty = true;

    float mCompEnvA = 0.f, mCompEnvR = 0.f, mCompThrLin = 1.f, mCompGrExp = 0.f, mCompMakeupLin = 1.f;
    float mDuckEnvA = 0.f, mDuckEnvR = 0.f;

    float mFollower = 0.f;
    float mLastAppliedFollower = -1.f;
    float mCompEnv = 0.f;
    float mGR = 1.f;
};

}  // namespace hcdyneq
