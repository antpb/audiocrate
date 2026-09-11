//
//  CostelloReverbEngine.h
//  homecrate synth
//
//  Sean-Costello-style modulated feedback-delay-network reverb.
//
//  Topology (per sample):
//    in → pre-delay → 4 series input-diffusion allpasses → 8-line modulated
//    FDN (Householder feedback + per-line one-pole damping) → wet sum.
//
//  The two ingredients that give the smooth, lush Costello character (and
//  that the previous static short-delay version lacked, hence the metallic
//  "sitar" ring) are (1) per-line delay MODULATION via a slow LFO with
//  fractional/interpolated reads, and (2) input DIFFUSION allpasses that
//  smear transients before they enter the tank. Not exposed through the
//  Objective-C bridging header.
//

#pragma once

#include <vector>
#include <cmath>
#include <algorithm>

class CostelloReverbEngine {
public:
    CostelloReverbEngine() = default;
    ~CostelloReverbEngine() = default;

    CostelloReverbEngine(const CostelloReverbEngine&) = delete;
    CostelloReverbEngine& operator=(const CostelloReverbEngine&) = delete;

    void setup(double sampleRate);
    void setFeedback(float feedback);   // tank feedback → tail length (RT60)
    void setCutoff(float hz);           // in-loop damping LP cutoff (tone)
    void setBlend(float blend);         // wet/dry mix
    void setSize(float size);           // scales the FDN delay taps (now dynamic)
    void setPreDelayMs(float ms);

    // In-place processing on a mono float buffer.
    void process(float* buf, int n);
    void reset();

private:
    static constexpr int kLines = 8;
    static constexpr int kDiff  = 4;

    // FDN delay lengths (samples @ 44.1k) — longer, coprime primes for a dense,
    // low-flutter tail. Each is modulated per-line to break up metallic ringing.
    static constexpr float kFDNLen44k[kLines] = {
        1259.0f, 1481.0f, 1693.0f, 1879.0f, 2113.0f, 2333.0f, 2579.0f, 2803.0f
    };
    // Per-line modulation LFO rate (Hz). Slightly different per line so the
    // lines de-correlate; depth is shared (kModDepth44k).
    static constexpr float kModRate[kLines] = {
        0.61f, 0.74f, 0.85f, 0.97f, 1.06f, 1.18f, 1.29f, 1.41f
    };
    static constexpr float kModDepth44k = 5.0f;   // ± samples @ 44.1k

    // Input diffusion allpasses (Dattorro-style lengths @ 44.1k) — smear the
    // input so a transient doesn't ring through as a discrete, sitar-like pitch.
    static constexpr int   kDiffLen44k[kDiff] = { 210, 158, 561, 410 };
    static constexpr float kDiffCoeff[kDiff]  = { 0.75f, 0.75f, 0.625f, 0.625f };

    double mSampleRate = 44100.0;
    float  mFeedback   = 0.85f;
    float  mBlend      = 0.0f;
    float  mSize       = 1.0f;
    float  mCutoff     = 7000.0f;
    float  mLPCoeff    = 0.0f;
    float  mModDepth   = 5.0f;     // sample-rate-scaled at setup()

    // Pre-delay buffer (0-100ms range)
    std::vector<float> mPreDelayBuf;
    int mPreDelayLen = 0;
    int mPreDelayWrite = 0;

    // Schroeder allpass (lattice form) for input diffusion.
    struct AllpassLine {
        std::vector<float> buf;
        int   writePos = 0;
        int   len      = 1;
        float coeff    = 0.7f;

        void setup(int n, float g) { buf.assign(n + 1, 0.0f); len = n; coeff = g; writePos = 0; }
        void clear() { std::fill(buf.begin(), buf.end(), 0.0f); writePos = 0; }

        inline float process(float x) {
            const int sz = static_cast<int>(buf.size());
            if (sz <= 0) return x;  // not yet set up — never index an empty buffer
            if (writePos < 0 || writePos >= sz) writePos = 0;  // recover from a stale/resized state
            // len < sz and writePos ∈ [0,sz), so (writePos - len) ∈ (-sz, sz):
            // a single conditional add replaces the per-sample integer modulo.
            int rp = writePos - len;
            if (rp < 0) rp += sz;
            const float dz = buf[rp];
            const float u  = x + coeff * dz;
            buf[writePos] = u;
            if (++writePos >= sz) writePos = 0;
            return dz - coeff * u;
        }
    };

    // Modulated FDN delay line with fractional (linear-interpolated) read.
    struct DelayLine {
        std::vector<float> buf;
        int   writePos = 0;
        float lpState  = 0.0f;     // one-pole damping state (in loop)
        float base     = 0.0f;     // delay @ size 1.0, in samples
        // Per-line modulation LFO. A "magic-circle" quadrature oscillator
        // replaces a per-sample std::sin(): it advances with 2 mul + 2 add and
        // is lossless (no drift, no renormalization), so the modulation signal is
        // still a sine — bit-for-bit equivalent in character — but without the
        // transcendental cost. 8 std::sin() per sample per reverb instance was a
        // dominant CPU/thermal cost (doubled with two synth instances).
        float lfoSin = 0.0f, lfoCos = 1.0f;           // live oscillator state
        float lfoInitSin = 0.0f, lfoInitCos = 1.0f;   // re-seed values for clear()
        float lfoEps = 0.0f;       // 2*sin(pi*rate/fs)

        void setup(int n) { buf.assign(n, 0.0f); writePos = 0; lpState = 0.0f; lfoSin = lfoInitSin; lfoCos = lfoInitCos; }
        void clear() { std::fill(buf.begin(), buf.end(), 0.0f); lpState = 0.0f; lfoSin = lfoInitSin; lfoCos = lfoInitCos; }

        // Configure the modulation oscillator: rate via eps, plus a starting phase
        // (lines use distinct phases to de-correlate, as before).
        void configMod(float eps, float phase0) {
            lfoEps     = eps;
            lfoInitSin = std::sin(phase0);
            lfoInitCos = std::cos(phase0);
            lfoSin     = lfoInitSin;
            lfoCos     = lfoInitCos;
        }

        // Advance the oscillator one sample and return its sine in [-1, 1].
        inline float nextMod() {
            lfoSin += lfoEps * lfoCos;
            lfoCos -= lfoEps * lfoSin;   // magic-circle (uses the just-updated sin)
            return lfoSin;
        }

        inline float readInterp(float delaySamples) const {
            const int sz = static_cast<int>(buf.size());
            if (sz <= 0) return 0.0f;  // not yet set up — never index an empty buffer
            // Bound the delay into the buffer, then a single conditional wrap
            // replaces std::fmod(): writePos ∈ [0,sz) and delaySamples is clamped
            // to [0, sz-2], so (writePos - delaySamples) ∈ (-sz, sz) and one add
            // of sz lands it in [0, sz). This keeps the iOS-26 OOB guarantee
            // (hardened libc++ aborts the whole AUv3 on any out-of-bounds
            // vector[]) without the per-sample fmod cost.
            if (delaySamples < 0.0f) delaySamples = 0.0f;
            const float maxDelay = static_cast<float>(sz) - 2.0f;
            if (delaySamples > maxDelay) delaySamples = maxDelay;
            float rp = static_cast<float>(writePos) - delaySamples;
            if (rp < 0.0f) rp += static_cast<float>(sz);
            int i0 = static_cast<int>(rp);
            if (i0 >= sz) i0 = sz - 1;  // guard the fp edge where rp rounds up to sz
            const float frac = rp - static_cast<float>(i0);
            int i1 = i0 + 1; if (i1 >= sz) i1 -= sz;
            return buf[i0] + frac * (buf[i1] - buf[i0]);
        }

        inline void write(float v) {
            buf[writePos] = v;
            if (++writePos >= static_cast<int>(buf.size())) writePos = 0;
        }
    };

    AllpassLine mDiff[kDiff];
    DelayLine   mLines[kLines];

    void recomputeLPCoeff();
};
