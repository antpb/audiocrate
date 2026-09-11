//
//  SynthOscillator.h
//  homecrate synth
//
//  Unified oscillator with 8 waveform types, ported from Mutable Instruments
//  Plaits. Uses POLYBLEP anti-aliasing for alias-free band-limited synthesis.
//
//  Waveforms:
//    0 = Sine        (wavetable lookup)
//    1 = Triangle    (integrated BLEP)
//    2 = Saw         (BLEP)
//    3 = Square      (BLEP, 50% duty)
//    4 = Pulse       (BLEP, variable width via shapeMod)
//    5 = VarShape    (morphing tri→saw→square)
//    6 = SuperSquare (two hard-synced squares)
//    7 = Harmonic    (additive via Chebyshev)
//

#pragma once

#include "StmlibCompat.h"
#include <cstring>
#include <memory>

class SynthOscillator {
public:
    enum Waveform {
        Sine = 0,
        Triangle,
        Saw,
        Square,
        Pulse,
        VarShape,
        SuperSquare,
        Harmonic,
        WaveformCount
    };

    SynthOscillator() = default;

    void init() {
        mPhase = 0.5f;
        mNextSample = 0.0f;
        mLpState = 1.0f;
        mHpState = 0.0f;
        mHigh = true;
        mFrequency = 0.001f;
        mPw = 0.5f;

        // SuperSquare state
        mSlavePhase = 0.0f;
        mSlaveNextSample = 0.0f;

        // Harmonic state
        for (int i = 0; i < kMaxHarmonics; ++i) {
            mHarmonicAmps[i] = 0.0f;
        }
        mLastHarmonicShape = -1.0f;
        mLastMaxHarm = 0;

        // Pre-allocate crossfade oscillator once (avoids heap alloc on audio thread)
        if (!mXfadeOsc) {
            mXfadeOsc = std::make_unique<SynthOscillator>();
        }
    }

    void setWaveform(Waveform w) {
        if (w != mWaveform && mXfadeSamplesLeft == 0) {
            mPrevWaveform = mWaveform;
            mXfadeSamplesLeft = kXfadeLength;
            // Snapshot current oscillator state into pre-allocated crossfade osc
            // (no heap allocation on the audio thread)
            if (!mXfadeOsc) mXfadeOsc = std::make_unique<SynthOscillator>();
            mXfadeOsc->mPhase = mPhase;
            mXfadeOsc->mNextSample = mNextSample;
            mXfadeOsc->mLpState = mLpState;
            mXfadeOsc->mHpState = mHpState;
            mXfadeOsc->mHigh = mHigh;
            mXfadeOsc->mFrequency = mFrequency;
            mXfadeOsc->mPw = mPw;
            mXfadeOsc->mSlavePhase = mSlavePhase;
            mXfadeOsc->mSlaveNextSample = mSlaveNextSample;
            std::memcpy(mXfadeOsc->mHarmonicAmps, mHarmonicAmps, sizeof(mHarmonicAmps));
        }
        mWaveform = w;
    }
    void setWaveform(int w) { setWaveform(static_cast<Waveform>(std::clamp(w, 0, (int)WaveformCount - 1))); }

    // Render a block of samples
    // frequency: normalized frequency (hz / sampleRate), typically 0.000001 to 0.25
    // shapeMod: 0..1, meaning depends on waveform
    void render(float frequency, float shapeMod, float* out, size_t size) {
        renderWaveform(mWaveform, frequency, shapeMod, out, size);

        // Crossfade from old waveform to avoid clicks on waveform switch
        if (mXfadeSamplesLeft > 0 && mXfadeOsc) {
            float oldBuf[1024];
            size_t xfadeSize = std::min(size, (size_t)1024);
            mXfadeOsc->renderWaveform(mPrevWaveform, frequency, shapeMod, oldBuf, xfadeSize);
            for (size_t i = 0; i < xfadeSize && mXfadeSamplesLeft > 0; ++i) {
                float t = (float)mXfadeSamplesLeft / (float)kXfadeLength;
                out[i] = out[i] * (1.0f - t) + oldBuf[i] * t;
                --mXfadeSamplesLeft;
            }
            // Don't reset mXfadeOsc — keep it pre-allocated for next crossfade
        }
    }

private:
    void renderWaveform(Waveform w, float frequency, float shapeMod, float* out, size_t size) {
        switch (w) {
            case Sine:       renderSine(frequency, out, size); break;
            case Triangle:   renderTriangle(frequency, out, size); break;
            case Saw:        renderSaw(frequency, out, size); break;
            case Square:     renderSquare(frequency, 0.5f, out, size); break;
            case Pulse:      renderSquare(frequency, shapeMod, out, size); break;
            case VarShape:   renderVarShape(frequency, shapeMod, out, size); break;
            case SuperSquare: renderSuperSquare(frequency, shapeMod, out, size); break;
            case Harmonic:   renderHarmonic(frequency, shapeMod, out, size); break;
            default:         renderSine(frequency, out, size); break;
        }
    }

    static constexpr float kMaxFreq = 0.25f;
    static constexpr float kMinFreq = 0.000001f;
    static constexpr int kMaxHarmonics = 16;
    static constexpr int kXfadeLength = 128; // ~2.7ms at 48kHz

    Waveform mWaveform = Saw;
    Waveform mPrevWaveform = Saw;
    int mXfadeSamplesLeft = 0;
    std::unique_ptr<SynthOscillator> mXfadeOsc; // snapshot for crossfade (heap to avoid recursion)

    // Core oscillator state (shared across most waveforms)
    float mPhase = 0.5f;
    float mNextSample = 0.0f;
    float mLpState = 1.0f;
    float mHpState = 0.0f;
    bool  mHigh = true;
    float mFrequency = 0.001f;
    float mPw = 0.5f;

    // SuperSquare state
    float mSlavePhase = 0.0f;
    float mSlaveNextSample = 0.0f;

    // Harmonic state
    float mHarmonicAmps[kMaxHarmonics] = {};
    float mLastHarmonicShape = -1.0f;  // cache key for harmonic amplitude computation
    int   mLastMaxHarm = 0;

    // ---- Sine (wavetable) ----
    void renderSine(float frequency, float* out, size_t size) {
        CONSTRAIN(frequency, kMinFreq, kMaxFreq);
        stmlib::ParameterInterpolator fm(&mFrequency, frequency, size);

        while (size--) {
            float f = fm.Next();
            mPhase += f;
            if (mPhase >= 1.0f) mPhase -= 1.0f;
            *out++ = synth_lut::SineLookup(mPhase);
        }
    }

    // ---- Triangle (BLEP-integrated) ----
    // From Plaits oscillator.h: OSCILLATOR_SHAPE_TRIANGLE branch
    void renderTriangle(float frequency, float* out, size_t size) {
        CONSTRAIN(frequency, kMinFreq, kMaxFreq);
        stmlib::ParameterInterpolator fm(&mFrequency, frequency, size);

        float next_sample = mNextSample;

        while (size--) {
            float this_sample = next_sample;
            next_sample = 0.0f;

            float f = fm.Next();
            mPhase += f;

            if (mPhase >= 1.0f) {
                mPhase -= 1.0f;
                float t = mPhase / f;
                this_sample -= stmlib::ThisBlepSample(t);
                next_sample -= stmlib::NextBlepSample(t);
            }
            next_sample += mPhase;

            // Leaky integrator for triangle
            mLpState += 0.25f * ((mHpState - this_sample) - mLpState);
            *out++ = 4.0f * mLpState;
            mHpState = this_sample;
        }
        mNextSample = next_sample;
    }

    // ---- Saw (BLEP) ----
    void renderSaw(float frequency, float* out, size_t size) {
        CONSTRAIN(frequency, kMinFreq, kMaxFreq);
        stmlib::ParameterInterpolator fm(&mFrequency, frequency, size);

        float next_sample = mNextSample;

        while (size--) {
            float this_sample = next_sample;
            next_sample = 0.0f;

            float f = fm.Next();
            mPhase += f;

            if (mPhase >= 1.0f) {
                mPhase -= 1.0f;
                float t = mPhase / f;
                this_sample -= stmlib::ThisBlepSample(t);
                next_sample -= stmlib::NextBlepSample(t);
            }
            next_sample += mPhase;

            *out++ = 2.0f * this_sample - 1.0f;
        }
        mNextSample = next_sample;
    }

    // ---- Square / Pulse (BLEP) ----
    // pw: pulse width, 0..1 (0.5 = square)
    void renderSquare(float frequency, float pw, float* out, size_t size) {
        CONSTRAIN(frequency, kMinFreq, kMaxFreq);
        CONSTRAIN(pw, frequency * 2.0f, 1.0f - 2.0f * frequency);
        stmlib::ParameterInterpolator fm(&mFrequency, frequency, size);
        stmlib::ParameterInterpolator pwm(&mPw, pw, size);

        float next_sample = mNextSample;

        while (size--) {
            float this_sample = next_sample;
            next_sample = 0.0f;

            float f = fm.Next();
            float p = pwm.Next();
            mPhase += f;

            if (mHigh ^ (mPhase >= p)) {
                float t = (mPhase - p) / f;
                this_sample += stmlib::ThisBlepSample(t);
                next_sample += stmlib::NextBlepSample(t);
                mHigh = mPhase >= p;
            }
            if (mPhase >= 1.0f) {
                mPhase -= 1.0f;
                float t = mPhase / f;
                this_sample -= stmlib::ThisBlepSample(t);
                next_sample -= stmlib::NextBlepSample(t);
                mHigh = false;
            }
            next_sample += mPhase < p ? 0.0f : 1.0f;

            *out++ = 2.0f * this_sample - 1.0f;
        }
        mNextSample = next_sample;
    }

    // ---- Variable Shape (tri → saw → square morph) ----
    // shapeMod: 0 = triangle, 0.5 = saw, 1.0 = square
    void renderVarShape(float frequency, float shapeMod, float* out, size_t size) {
        CONSTRAIN(frequency, kMinFreq, kMaxFreq);

        // Map shapeMod to pulse width: 0.5 (tri) → ~0.0 (saw) → 0.5 (square behavior)
        float pw;
        if (shapeMod < 0.5f) {
            // Triangle (0.5) to Saw (~0.001)
            pw = 0.5f - shapeMod;
        } else {
            // Saw to Square-ish via slope
            pw = (shapeMod - 0.5f);
        }
        CONSTRAIN(pw, frequency * 2.0f, 1.0f - 2.0f * frequency);

        stmlib::ParameterInterpolator fm(&mFrequency, frequency, size);
        stmlib::ParameterInterpolator pwm(&mPw, pw, size);

        float next_sample = mNextSample;

        while (size--) {
            float this_sample = next_sample;
            next_sample = 0.0f;

            float f = fm.Next();
            float p = pwm.Next();

            float slope_up = 1.0f / (p + 0.001f);
            float slope_down = 1.0f / (1.0f - p + 0.001f);

            mPhase += f;

            if (mHigh ^ (mPhase < p)) {
                float t = (mPhase - p) / f;
                float discontinuity = (slope_up + slope_down) * f;
                this_sample -= stmlib::ThisIntegratedBlepSample(t) * discontinuity;
                next_sample -= stmlib::NextIntegratedBlepSample(t) * discontinuity;
                mHigh = mPhase < p;
            }
            if (mPhase >= 1.0f) {
                mPhase -= 1.0f;
                float t = mPhase / f;
                float discontinuity = (slope_up + slope_down) * f;
                this_sample += stmlib::ThisIntegratedBlepSample(t) * discontinuity;
                next_sample += stmlib::NextIntegratedBlepSample(t) * discontinuity;
                mHigh = true;
            }

            next_sample += mHigh
                ? mPhase * slope_up
                : 1.0f - (mPhase - p) * slope_down;

            *out++ = 2.0f * this_sample - 1.0f;
        }
        mNextSample = next_sample;
    }

    // ---- Super Square (two hard-synced squares) ----
    // shapeMod controls the slave frequency ratio (1.0 to 4.0)
    void renderSuperSquare(float frequency, float shapeMod, float* out, size_t size) {
        CONSTRAIN(frequency, kMinFreq, kMaxFreq);
        float ratio = 1.0f + shapeMod * 3.0f;  // 1x to 4x slave ratio

        stmlib::ParameterInterpolator fm(&mFrequency, frequency, size);
        float next_sample = mNextSample;
        float slave_next = mSlaveNextSample;

        while (size--) {
            float this_sample = next_sample;
            float slave_this = slave_next;
            next_sample = 0.0f;
            slave_next = 0.0f;

            float f = fm.Next();
            float slaveF = f * ratio;

            mPhase += f;
            mSlavePhase += slaveF;

            // Master reset
            if (mPhase >= 1.0f) {
                mPhase -= 1.0f;
                float t = mPhase / f;
                this_sample -= stmlib::ThisBlepSample(t);
                next_sample -= stmlib::NextBlepSample(t);

                // Hard sync: reset slave
                float oldSlavePhase = mSlavePhase;
                mSlavePhase = mPhase * ratio;
                // BLEP at slave discontinuity
                float slaveDelta = mSlavePhase - oldSlavePhase;
                if (fabsf(slaveDelta) > 0.5f) {
                    slave_this += stmlib::ThisBlepSample(t) * (slaveDelta > 0 ? -1.0f : 1.0f);
                    slave_next += stmlib::NextBlepSample(t) * (slaveDelta > 0 ? -1.0f : 1.0f);
                }
            }

            // Slave square wave
            if (mSlavePhase >= 1.0f) {
                mSlavePhase -= 1.0f;
                float t = mSlavePhase / slaveF;
                slave_this -= stmlib::ThisBlepSample(t);
                slave_next -= stmlib::NextBlepSample(t);
            }

            next_sample += mPhase;
            slave_next += (mSlavePhase < 0.5f) ? 1.0f : 0.0f;

            // Mix master saw with slave square
            float master = 2.0f * this_sample - 1.0f;
            float slave  = 2.0f * slave_this - 1.0f;
            *out++ = (master + slave) * 0.5f;
        }
        mNextSample = next_sample;
        mSlaveNextSample = slave_next;
    }

    // ---- Harmonic (additive synthesis via direct computation) ----
    // shapeMod controls harmonic tilt: 0 = fundamental only, 1 = bright (equal amplitudes)
    void renderHarmonic(float frequency, float shapeMod, float* out, size_t size) {
        CONSTRAIN(frequency, kMinFreq, kMaxFreq);

        // Determine max harmonic that fits below Nyquist
        int maxHarm = std::min(kMaxHarmonics, static_cast<int>(0.5f / frequency));
        if (maxHarm < 1) maxHarm = 1;

        // Recompute harmonic amplitudes only when shapeMod or maxHarm changes
        if (shapeMod != mLastHarmonicShape || maxHarm != mLastMaxHarm) {
            mLastHarmonicShape = shapeMod;
            mLastMaxHarm = maxHarm;
            float tilt = shapeMod;
            float normalization = 0.0f;
            for (int h = 0; h < maxHarm; ++h) {
                float harmNum = static_cast<float>(h + 1);
                // Amplitude falls off as 1/n^(2-2*tilt)
                // tilt=0: 1/n^2 (mellow), tilt=0.5: 1/n (saw-like), tilt=1: equal (bright)
                float exponent = 2.0f * (1.0f - tilt);
                mHarmonicAmps[h] = 1.0f / powf(harmNum, exponent);
                normalization += mHarmonicAmps[h];
            }
            if (normalization > 0.0f) {
                float invNorm = 1.0f / normalization;
                for (int h = 0; h < maxHarm; ++h) {
                    mHarmonicAmps[h] *= invNorm;
                }
            }
        }

        stmlib::ParameterInterpolator fm(&mFrequency, frequency, size);

        while (size--) {
            float f = fm.Next();
            mPhase += f;
            if (mPhase >= 1.0f) mPhase -= 1.0f;

            float sample = 0.0f;
            for (int h = 0; h < maxHarm; ++h) {
                float harmPhase = mPhase * static_cast<float>(h + 1);
                harmPhase -= static_cast<int>(harmPhase);  // wrap to [0, 1)
                sample += mHarmonicAmps[h] * synth_lut::SineLookup(harmPhase);
            }
            *out++ = sample;
        }
    }
};
