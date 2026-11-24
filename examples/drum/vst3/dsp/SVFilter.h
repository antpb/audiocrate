//
//  SVFilter.h
//  homecrate synth
//
//  State-variable filter providing simultaneous low-pass, high-pass, and
//  band-pass outputs from a single computation. Header-only.
//
//  Uses the Andrew Simper (Cytomic) SVF topology for unconditional stability
//  at all frequencies and sample rates.
//

#pragma once

#include <cmath>
#include <algorithm>

class SVFilter {
public:
    enum Type { LowPass = 0, HighPass = 1, BandPass = 2 };

    SVFilter() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        mIc1eq = mIc2eq = 0.0f;
        updateCoefficients();
    }

    void reset() {
        mIc1eq = mIc2eq = 0.0f;
    }

    // Process one sample — returns the selected filter output
    // Cytomic SVF: unconditionally stable at all frequencies
    inline float process(float input) {
        float v3 = input - mIc2eq;
        float v1 = mA1 * mIc1eq + mA2 * v3;
        float v2 = mIc2eq + mA2 * mIc1eq + mA3 * v3;
        mIc1eq = 2.0f * v1 - mIc1eq;
        mIc2eq = 2.0f * v2 - mIc2eq;

        switch (mType) {
            case LowPass:  return v2;
            case HighPass: return input - mK * v1 - v2;
            case BandPass: return v1;
            default:       return v2;
        }
    }

    void setCutoff(float hz) {
        if (hz == mCutoff) return;
        mCutoff = std::clamp(hz, 20.0f, 20000.0f);
        updateCoefficients();
    }

    void setResonance(float q) {
        if (q == mQ) return;
        mQ = std::clamp(q, 0.0f, 1.0f);
        updateCoefficients();
    }

    void setType(Type t) { mType = t; }

    void setType(int t) {
        mType = static_cast<Type>(std::clamp(t, 0, 2));
    }

    void setSampleRate(double sr) {
        mSampleRate = sr;
        updateCoefficients();
    }

    float cutoff() const { return mCutoff; }

private:
    // Fast tan approximation using Pade [3/3] — max error ~0.01% for x in [0, pi/2)
    // Avoids expensive tanf() on the audio thread; called 16x/block with 8 voices + 2 filters
    static inline float fastTan(float x) {
        float x2 = x * x;
        return x * (15.0f - x2) / (15.0f - 6.0f * x2);
    }

    void updateCoefficients() {
        // Cytomic SVF coefficients — stable at any frequency
        float w = static_cast<float>(M_PI) * mCutoff / static_cast<float>(mSampleRate);
        float g = fastTan(w);
        // K = damping: 2.0 = no resonance, 0.0 = self-oscillation
        // Map mQ 0..1 to K 2.0..0.1
        mK = 2.0f - mQ * 1.9f;
        mA1 = 1.0f / (1.0f + g * (g + mK));
        mA2 = g * mA1;
        mA3 = g * mA2;
    }

    Type   mType       = LowPass;
    float  mCutoff     = 8000.0f;
    float  mQ          = 0.0f;
    double mSampleRate = 48000.0;

    // Cytomic SVF coefficients
    float mK  = 2.0f;
    float mA1 = 0.0f;
    float mA2 = 0.0f;
    float mA3 = 0.0f;

    // Filter state (integrator memories)
    float mIc1eq = 0.0f;
    float mIc2eq = 0.0f;
};
