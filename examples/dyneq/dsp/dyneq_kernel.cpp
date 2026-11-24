// See dyneq_kernel.h. Every expression below is the .mm's, in its types.
#include "dyneq_kernel.h"

#include <algorithm>
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace hcdyneq {

Kernel::Kernel(double sampleRate) : mSampleRate(sampleRate) {}

void Kernel::setParameter(int address, float value) {
    switch (address) {
        case inputGain: mInputGain = value; break;
        case outputGain: mOutputGain = value; break;
        case eqBand0: case eqBand1: case eqBand2: case eqBand3: case eqBand4:
            mEQGainDB[address - eqBand0] = value;
            mEQDirty = true;
            break;
        case duckDepth0: case duckDepth1: case duckDepth2: case duckDepth3: case duckDepth4:
            mDuckDepthDB[address - duckDepth0] = value;
            mEQDirty = true;
            break;
        case duckAttack: mDuckAtkMs = value; mDynDirty = true; break;
        case duckRelease: mDuckRelMs = value; mDynDirty = true; break;
        case compThresh: mCompThreshDB = value; mDynDirty = true; break;
        case compRatio: mCompRatio = value; mDynDirty = true; break;
        case compAttack: mCompAtkMs = value; mDynDirty = true; break;
        case compRelease: mCompRelMs = value; mDynDirty = true; break;
        case compMakeup: mCompMakeupDB = value; mDynDirty = true; break;
        case compKey: mCompKey = std::clamp(static_cast<int>(value + 0.5f), 0, 1); break;
        case compPlacement: mCompPlacement = std::clamp(static_cast<int>(value + 0.5f), 0, 1); break;
        default: break;
    }
}

void Kernel::process(const float *in_l, const float *in_r, float *out_l, float *out_r, int n, float bus) {
    const float inGain = mInputGain;
    const float outGain = mOutputGain;

    if (mDynDirty) {
        mDynDirty = false;
        recomputeCompCoeffs();
    }
    const bool eqParamsDirty = mEQDirty;
    mEQDirty = false;

    // Envelope-bus read -> smoothed follower (closed-form one-pole over the block).
    {
        float raw = std::clamp(bus, 0.f, 2.f);
        const float k = (raw > mFollower) ? mDuckEnvA : mDuckEnvR;
        mFollower = raw + (mFollower - raw) * std::pow(1.f - k, static_cast<float>(n));
        if (mFollower < 1e-5f) mFollower = 0.f;
    }

    // Duck EQ coefficients: on param change or follower motion past 0.01.
    {
        const float f = std::min(mFollower, 1.f);
        if (eqParamsDirty || std::fabs(f - mLastAppliedFollower) > 0.01f) recomputeEQCoeffs(f);
    }

    const float *src_r = in_r ? in_r : in_l;
    for (int f = 0; f < n; ++f) out_l[f] = in_l[f] * inGain;
    if (out_r) for (int f = 0; f < n; ++f) out_r[f] = src_r[f] * inGain;

    if (mCompPlacement == 0) runComp(out_l, out_r, n);
    applyEQ(out_l, n, 0);
    if (out_r) applyEQ(out_r, n, 1);
    if (mCompPlacement == 1) runComp(out_l, out_r, n);

    // 0->1 fade-in at start + hard safety clamp +-1.5 x output gain.
    const int fadeRemaining = mFadeInRemaining;
    const float total = static_cast<float>(mFadeInSamples > 0 ? mFadeInSamples : 1);
    float *outs[2] = {out_l, out_r};
    for (float *out : outs) {
        if (!out) continue;
        for (int f = 0; f < n; ++f) {
            float gain = outGain;
            if (fadeRemaining > 0) {
                const int remaining = fadeRemaining - f;
                if (remaining > 0) gain *= 1.f - (static_cast<float>(remaining) / total);
            }
            out[f] = std::clamp(out[f] * gain, -1.5f, 1.5f);
        }
    }
    if (fadeRemaining > 0) mFadeInRemaining = std::max(0, fadeRemaining - n);
}

void Kernel::runComp(float *chL, float *chR, int n) {
    const bool active = (mCompThreshDB < -0.01f) || (mCompMakeupDB > 0.01f);
    if (!active || !chL) {
        mGR = 1.f;
        return;
    }
    const float followerDet = std::min(mFollower, 2.f);
    float minG = 1.f;
    for (int f = 0; f < n; ++f) {
        float a;
        if (mCompKey == 1) {
            a = followerDet;
        } else {
            const float l = std::fabs(chL[f]);
            const float r = chR ? std::fabs(chR[f]) : l;
            a = std::max(l, r);
        }
        mCompEnv += (a > mCompEnv ? mCompEnvA : mCompEnvR) * (a - mCompEnv);
        float g = 1.f;
        if (mCompEnv > mCompThrLin) g = std::pow(mCompEnv / mCompThrLin, mCompGrExp);
        if (g < minG) minG = g;
        const float gm = g * mCompMakeupLin;
        chL[f] *= gm;
        if (chR) chR[f] *= gm;
    }
    mGR = minG;
}

void Kernel::recomputeCompCoeffs() {
    const float sr = static_cast<float>(mSampleRate);
    mCompEnvA = 1.f - std::exp(-1.f / (std::max(0.0001f, mCompAtkMs * 0.001f) * sr));
    mCompEnvR = 1.f - std::exp(-1.f / (std::max(0.001f, mCompRelMs * 0.001f) * sr));
    mCompThrLin = std::pow(10.f, mCompThreshDB / 20.f);
    mCompGrExp = 1.f / std::max(1.f, mCompRatio) - 1.f;
    mCompMakeupLin = std::pow(10.f, mCompMakeupDB / 20.f);
    mDuckEnvA = 1.f - std::exp(-1.f / (std::max(0.0005f, mDuckAtkMs * 0.001f) * sr));
    mDuckEnvR = 1.f - std::exp(-1.f / (std::max(0.005f, mDuckRelMs * 0.001f) * sr));
}

void Kernel::recomputeEQCoeffs(float follower) {
    static constexpr double kFreqs[kEQBands] = {100.0, 300.0, 1200.0, 3500.0, 10000.0};
    static constexpr double kQ = 0.9;
    for (int b = 0; b < kEQBands; ++b) {
        const double gainDB = double(mEQGainDB[b]) + double(mDuckDepthDB[b]) * double(follower);
        if (std::abs(gainDB) < 0.01) {
            mEQCoeffs[b] = {};
            continue;
        }
        const double A = std::pow(10.0, gainDB / 40.0);
        const double w0 = 2.0 * M_PI * kFreqs[b] / mSampleRate;
        const double alpha = std::sin(w0) / (2.0 * kQ);
        const double cosw0 = std::cos(w0);
        const double b0 = 1.0 + alpha * A;
        const double b1 = -2.0 * cosw0;
        const double b2 = 1.0 - alpha * A;
        const double a0 = 1.0 + alpha / A;
        const double a1 = -2.0 * cosw0;
        const double a2 = 1.0 - alpha / A;
        mEQCoeffs[b] = {b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
    }
    mLastAppliedFollower = follower;
}

void Kernel::applyEQ(float *buf, int n, int ch) {
    auto &state = (ch == 0) ? mEQState : mEQStateR;
    for (int b = 0; b < kEQBands; ++b) {
        const auto &c = mEQCoeffs[b];
        if (c.b0 == 1.0 && c.b1 == 0.0 && c.b2 == 0.0 && c.a1 == 0.0 && c.a2 == 0.0) continue;
        auto &s = state[b];
        for (int f = 0; f < n; ++f) {
            const double x = buf[f];
            const double y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
            s.x2 = s.x1; s.x1 = x;
            s.y2 = s.y1; s.y1 = y;
            buf[f] = static_cast<float>(y);
        }
    }
}

}  // namespace hcdyneq
