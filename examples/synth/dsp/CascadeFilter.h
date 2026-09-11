//
//  CascadeFilter.h
//  homecrate synth
//
//  Butterworth biquad cascade filter. Clean, clinical character.
//  6/12/18/24 dB/oct via 1-pole and 2nd-order biquad stages.
//  Direct-form II transposed biquads with Audio EQ Cookbook coefficients.
//  Header-only. Thread-unsafe — one instance per voice.
//

#pragma once
#include <cmath>
#include <algorithm>

class CascadeFilter {
public:
    enum Type { LowPass = 0, HighPass = 1, BandPass = 2 };

    CascadeFilter() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        reset();
        updateCoefficients();
    }

    void reset() {
        lp1 = {}; hp1 = {};
        for (int i = 0; i < 2; ++i) { lpBq[i] = {}; hpBq[i] = {}; }
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
    void setType(int t)  { mType = static_cast<Type>(std::clamp(t, 0, 2)); }

    // order: 1=6dB, 2=12dB, 3=18dB, 4=24dB
    void setOrder(int order) {
        if (order == mOrder) return;
        mOrder = std::clamp(order, 1, 4);
        reset();
        updateCoefficients();
    }

    void setSampleRate(double sr) {
        mSampleRate = sr;
        updateCoefficients();
    }

    float cutoff() const { return mCutoff; }

    inline float process(float input) {
        switch (mType) {
            case LowPass:  return runLP(input);
            case HighPass: return runHP(input);
            case BandPass: return runHP(runLP(input));
            default:       return runLP(input);
        }
    }

    // Exposed for PolyFilter SVF order-1 path
    inline float processLP6(float input) { return lp1.process(input); }
    inline float processHP6(float input) { return hp1.process(input); }

private:
    // Direct-form II transposed biquad state
    struct BqState {
        float b0=1, b1=0, b2=0, a1=0, a2=0;
        float s1=0, s2=0;
        inline float process(float x) {
            float y = b0 * x + s1;
            s1 = b1 * x - a1 * y + s2;
            s2 = b2 * x - a2 * y;
            return y;
        }
    };

    inline float runLP(float x) {
        // order 1 and 3 use the 1-pole stage first
        if (mOrder == 1 || mOrder == 3) x = lp1.process(x);
        // order 2, 3, and 4 use first biquad stage
        if (mOrder >= 2) x = lpBq[0].process(x);
        // order 4 uses second biquad stage
        if (mOrder == 4) x = lpBq[1].process(x);
        return x;
    }

    inline float runHP(float x) {
        if (mOrder == 1 || mOrder == 3) x = hp1.process(x);
        if (mOrder >= 2) x = hpBq[0].process(x);
        if (mOrder == 4) x = hpBq[1].process(x);
        return x;
    }

    void updateCoefficients() {
        const double fs = mSampleRate > 0 ? mSampleRate : 48000.0;
        const double fc = static_cast<double>(mCutoff);

        // Q for single biquad stage: flat Butterworth at Q=0, resonant at Q=1
        const double baseQ = 0.7071;
        const double userQ = baseQ + static_cast<double>(mQ) * 1.8;

        // Butterworth 4-pole section Qs (maximally flat passband), shifted by user resonance
        const double q1 = 0.5412 + static_cast<double>(mQ) * (userQ - 0.5412);
        const double q2 = 1.3066 + static_cast<double>(mQ) * (userQ - 1.3066);

        // 1-pole bilinear stage (used for order 1 and 3)
        {
            double w = M_PI * fc / fs;
            double t = tan(w);
            double a = (1.0 - t) / (1.0 + t);
            // LP: b0=b1=(1-a)/2, a1=-a
            lp1.b0 = lp1.b1 = static_cast<float>((1.0 - a) * 0.5);
            lp1.b2 = 0.0f; lp1.a1 = static_cast<float>(-a); lp1.a2 = 0.0f;
            // HP: b0=(1+a)/2, b1=-(1+a)/2, a1=-a
            hp1.b0 = static_cast<float>((1.0 + a) * 0.5);
            hp1.b1 = -hp1.b0;
            hp1.b2 = 0.0f; hp1.a1 = static_cast<float>(-a); hp1.a2 = 0.0f;
        }

        // 2nd-order biquad stages
        calcLP(lpBq[0], fc, q1, fs);
        calcHP(hpBq[0], fc, q1, fs);
        calcLP(lpBq[1], fc, q2, fs);
        calcHP(hpBq[1], fc, q2, fs);
    }

    static void calcLP(BqState& bq, double fc, double Q, double fs) {
        double w0 = 2.0 * M_PI * fc / fs;
        double alpha = sin(w0) / (2.0 * Q);
        double cosw  = cos(w0);
        double a0    = 1.0 + alpha;
        bq.b0 = static_cast<float>((1.0 - cosw) * 0.5 / a0);
        bq.b1 = static_cast<float>((1.0 - cosw) / a0);
        bq.b2 = bq.b0;
        bq.a1 = static_cast<float>(-2.0 * cosw / a0);
        bq.a2 = static_cast<float>((1.0 - alpha) / a0);
    }

    static void calcHP(BqState& bq, double fc, double Q, double fs) {
        double w0 = 2.0 * M_PI * fc / fs;
        double alpha = sin(w0) / (2.0 * Q);
        double cosw  = cos(w0);
        double a0    = 1.0 + alpha;
        bq.b0 = static_cast<float>((1.0 + cosw) * 0.5 / a0);
        bq.b1 = static_cast<float>(-(1.0 + cosw) / a0);
        bq.b2 = bq.b0;
        bq.a1 = static_cast<float>(-2.0 * cosw / a0);
        bq.a2 = static_cast<float>((1.0 - alpha) / a0);
    }

    Type   mType       = LowPass;
    int    mOrder      = 2;
    float  mCutoff     = 2000.0f;
    float  mQ          = 0.0f;
    double mSampleRate = 48000.0;

    BqState lp1, hp1;        // 1-pole stages (b2=a2=0)
    BqState lpBq[2], hpBq[2]; // 2nd-order biquad stages
};
