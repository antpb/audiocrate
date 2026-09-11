//
//  LadderFilter.h
//  homecrate synth
//
//  Moog-style 4-pole transistor ladder filter.
//  Huovilainen simplified model: tanhf at input and feedback path only.
//  Provides LP taps at each pole (6/12/18/24 dB/oct), HP and BP via subtraction.
//  Header-only. Thread-unsafe — one instance per voice.
//

#pragma once
#include <cmath>
#include <algorithm>

class LadderFilter {
public:
    enum Type { LowPass = 0, HighPass = 1, BandPass = 2 };

    LadderFilter() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        reset();
        updateCoefficients();
    }

    void reset() {
        mY1 = mY2 = mY3 = mY4 = 0.0f;
    }

    void setCutoff(float hz) {
        if (hz == mCutoff) return;
        mCutoff = std::clamp(hz, 20.0f, 20000.0f);
        updateCoefficients();
    }

    // q in [0, 1]; approaches self-oscillation near 1.0
    void setResonance(float q) {
        if (q == mQ) return;
        mQ = std::clamp(q, 0.0f, 1.0f);
        mFeedback = mQ * 3.98f;
    }

    void setType(Type t) { mType = t; }
    void setType(int t)  { mType = static_cast<Type>(std::clamp(t, 0, 2)); }

    // order: 1=6dB, 2=12dB, 3=18dB, 4=24dB
    void setOrder(int order) { mOrder = std::clamp(order, 1, 4); }

    void setSampleRate(double sr) {
        mSampleRate = sr;
        updateCoefficients();
    }

    float cutoff() const { return mCutoff; }

    inline float process(float input) {
        // Feedback with soft saturation to prevent runaway
        float fb = tanhf(mFeedback * mY4);
        float x = tanhf(input - fb);

        // 4 one-pole stages
        mY1 += mG * (x    - mY1);
        mY2 += mG * (mY1  - mY2);
        mY3 += mG * (mY2  - mY3);
        mY4 += mG * (mY3  - mY4);

        // Select LP output at requested order
        float lp = 0.0f, lpPrev = 0.0f;
        switch (mOrder) {
            case 1: lp = mY1; lpPrev = x;    break;
            case 2: lp = mY2; lpPrev = mY1;  break;
            case 3: lp = mY3; lpPrev = mY2;  break;
            default:lp = mY4; lpPrev = mY3;  break;
        }

        switch (mType) {
            case LowPass:  return lp;
            case HighPass: return input - lp;
            case BandPass: return lpPrev - lp;
            default:       return lp;
        }
    }

private:
    void updateCoefficients() {
        // Bilinear 1-pole: g = tan(pi*fc/fs) / (1 + tan(pi*fc/fs))
        float w = static_cast<float>(M_PI) * mCutoff / static_cast<float>(mSampleRate);
        w = std::min(w, 1.45f); // clamp before tan() — safe upper bound
        float t = tanf(w);
        mG = t / (1.0f + t);
    }

    Type   mType       = LowPass;
    int    mOrder      = 2;
    float  mCutoff     = 2000.0f;
    float  mQ          = 0.0f;
    double mSampleRate = 48000.0;

    float  mG          = 0.0f;
    float  mFeedback   = 0.0f;

    float  mY1 = 0.0f;
    float  mY2 = 0.0f;
    float  mY3 = 0.0f;
    float  mY4 = 0.0f;
};
