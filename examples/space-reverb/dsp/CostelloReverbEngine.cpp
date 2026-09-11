//
//  CostelloReverbEngine.cpp
//  homecrate amp
//

#include "CostelloReverbEngine.h"

constexpr float CostelloReverbEngine::kFDNLen44k[kLines];
constexpr float CostelloReverbEngine::kModRate[kLines];
constexpr int   CostelloReverbEngine::kDiffLen44k[kDiff];
constexpr float CostelloReverbEngine::kDiffCoeff[kDiff];

void CostelloReverbEngine::setup(double sampleRate) {
    mSampleRate = sampleRate;
    const float srScale  = static_cast<float>(sampleRate) / 44100.0f;
    const float kMaxSize = 2.0f;
    mModDepth = kModDepth44k * srScale;

    // Input diffusion allpasses (fixed; not size-scaled).
    for (int i = 0; i < kDiff; ++i) {
        int len = std::max(1, static_cast<int>(kDiffLen44k[i] * srScale + 0.5f));
        mDiff[i].setup(len, kDiffCoeff[i]);
    }

    // FDN lines. Buffers sized for the largest possible read: base × maxSize +
    // full modulation depth + interpolation margin.
    for (int i = 0; i < kLines; ++i) {
        auto& L = mLines[i];
        L.base = kFDNLen44k[i] * srScale;
        int len = static_cast<int>(std::ceil(L.base * kMaxSize + mModDepth + 4.0f)) + 1;
        L.setup(len);
        // Magic-circle LFO coefficient: eps = 2 sin(pi f / fs) yields an
        // oscillator at kModRate[i] Hz. De-correlate the lines with distinct
        // starting phases, exactly as the old per-sample std::sin() path did.
        const float eps = 2.0f * std::sin(static_cast<float>(M_PI) * kModRate[i]
                                          / static_cast<float>(sampleRate));
        L.configMod(eps, static_cast<float>(i) * 0.37f);
    }

    int maxPreDelay = static_cast<int>(0.1 * sampleRate + 0.5);
    mPreDelayBuf.assign(maxPreDelay, 0.0f);
    mPreDelayLen = 0;
    mPreDelayWrite = 0;

    recomputeLPCoeff();
}

void CostelloReverbEngine::setFeedback(float feedback) {
    // Clamp to [0, 0.98] — values >= 1.0 are unstable.
    mFeedback = std::max(0.0f, std::min(0.98f, feedback));
}

void CostelloReverbEngine::setCutoff(float hz) {
    mCutoff = hz;
    recomputeLPCoeff();
}

void CostelloReverbEngine::setBlend(float blend) {
    mBlend = std::max(0.0f, std::min(1.0f, blend));
}

void CostelloReverbEngine::setSize(float size) {
    // Now dynamic — the read taps scale by mSize every sample, so SIZE no
    // longer requires a re-setup() to take effect.
    mSize = std::max(0.5f, std::min(2.0f, size));
}

void CostelloReverbEngine::setPreDelayMs(float ms) {
    ms = std::max(0.0f, std::min(100.0f, ms));
    mPreDelayLen = static_cast<int>(ms * 0.001f * mSampleRate + 0.5f);
    if (mPreDelayLen >= static_cast<int>(mPreDelayBuf.size())) {
        mPreDelayLen = static_cast<int>(mPreDelayBuf.size()) - 1;
    }
}

void CostelloReverbEngine::reset() {
    for (auto& d : mDiff)  d.clear();
    for (auto& L : mLines) L.clear();
    std::fill(mPreDelayBuf.begin(), mPreDelayBuf.end(), 0.0f);
    mPreDelayWrite = 0;
}

void CostelloReverbEngine::recomputeLPCoeff() {
    // One-pole IIR low-pass: y[n] = (1-c)*x[n] + c*y[n-1], c = exp(-2π fc / fs)
    mLPCoeff = std::exp(-2.0f * static_cast<float>(M_PI) * mCutoff / static_cast<float>(mSampleRate));
}

void CostelloReverbEngine::process(float* buf, int n) {
    if (mBlend < 1e-4f) return;

    const float g    = mFeedback;
    const float lp   = mLPCoeff;
    const float wet  = mBlend;
    const float dry  = 1.0f - wet;
    const float size = mSize;
    const float scale = 2.0f / static_cast<float>(kLines);
    const int   preDelaySamples = mPreDelayLen;
    const int   preBufSize = static_cast<int>(mPreDelayBuf.size());

    for (int s = 0; s < n; ++s) {
        const float in = buf[s];

        // ── Pre-delay ────────────────────────────────────────────────────
        float x = in;
        if (preDelaySamples > 0 && preBufSize > 0) {
            int readIdx = mPreDelayWrite - preDelaySamples;
            if (readIdx < 0) readIdx += preBufSize;
            x = mPreDelayBuf[readIdx];
            mPreDelayBuf[mPreDelayWrite] = in;
            if (++mPreDelayWrite >= preBufSize) mPreDelayWrite = 0;
        }

        // ── Input diffusion (smears transients) ──────────────────────────
        for (int d = 0; d < kDiff; ++d) x = mDiff[d].process(x);

        // ── Read modulated FDN taps ──────────────────────────────────────
        float v[kLines];
        for (int k = 0; k < kLines; ++k) {
            DelayLine& L = mLines[k];
            const float mod = mModDepth * L.nextMod();   // cheap recursive sine LFO
            v[k] = L.readInterp(L.base * size + mod);
        }

        float sum = 0.0f;
        for (int k = 0; k < kLines; ++k) sum += v[k];

        // ── Householder feedback + in-loop damping ───────────────────────
        for (int k = 0; k < kLines; ++k) {
            DelayLine& L = mLines[k];
            const float mixed = v[k] - scale * sum;       // lossless reflection
            const float fed   = x + g * mixed;
            float st = fed * (1.0f - lp) + L.lpState * lp; // damping
            if (std::fabs(st) < 1e-20f) st = 0.0f;         // flush denormals
            L.lpState = st;
            L.write(st);
        }

        const float wetSample = sum * (1.0f / static_cast<float>(kLines));
        buf[s] = dry * in + wet * wetSample;
    }
}
