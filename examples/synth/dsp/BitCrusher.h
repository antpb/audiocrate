//
//  BitCrusher.h
//  homecrate synth
//
//  Bit depth reduction + sample rate reduction effect.
//  Adapted from Mutable Instruments Plaits sample_rate_reducer.h with
//  added bit depth crushing. Header-only.
//
//  Parameters:
//    mix:        0..1 dry/wet blend
//    bitDepth:   1..16 (16 = clean, 1 = extreme)
//    sampleRate: 0..1 (1 = native, 0 = chaos)
//

#pragma once

#include "StmlibCompat.h"

class BitCrusher {
public:
    BitCrusher() = default;

    void init() {
        mPhase = 0.0f;
        mSample = 0.0f;
        mNextSample = 0.0f;
        mPreviousSample = 0.0f;
    }

    // Process a mono buffer in-place
    void process(float* buf, int n, float mix, float bitDepth, float sampleRateParam) {
        if (mix < 0.0001f) return;  // Fully dry, skip

        // Bit crushing setup
        float quantLevels = powf(2.0f, bitDepth) - 1.0f;
        float invQuantLevels = 1.0f / quantLevels;

        // Sample rate reduction frequency (0 = very low, 1 = bypass)
        float frequency = sampleRateParam;
        CONSTRAIN(frequency, 0.001f, 1.0f);

        float previous_sample = mPreviousSample;
        float next_sample = mNextSample;
        float sample = mSample;
        float phase = mPhase;

        for (int i = 0; i < n; ++i) {
            float dry = buf[i];
            float input = dry;

            // ---- Bit Crushing ----
            if (bitDepth < 15.9f) {
                // Quantize to reduced bit depth
                float scaled = (input * 0.5f + 0.5f) * quantLevels;
                scaled = floorf(scaled + 0.5f);
                input = (scaled * invQuantLevels) * 2.0f - 1.0f;
            }

            // ---- Sample Rate Reduction (with BLEP anti-aliasing) ----
            if (frequency < 0.999f) {
                float this_sample = next_sample;
                next_sample = 0.0f;
                phase += frequency;

                if (phase >= 1.0f) {
                    phase -= 1.0f;
                    float t = phase / frequency;
                    // Linear interpolation to recover fractional sample
                    float new_sample = previous_sample + (input - previous_sample) * (1.0f - t);
                    float discontinuity = new_sample - sample;
                    this_sample += discontinuity * stmlib::ThisBlepSample(t);
                    next_sample += discontinuity * stmlib::NextBlepSample(t);
                    sample = new_sample;
                }
                next_sample += sample;
                previous_sample = input;
                input = this_sample;
            }

            // ---- Dry/Wet Mix ----
            buf[i] = dry * (1.0f - mix) + input * mix;
        }

        mPhase = phase;
        mNextSample = next_sample;
        mSample = sample;
        mPreviousSample = previous_sample;
    }

private:
    float mPhase = 0.0f;
    float mSample = 0.0f;
    float mPreviousSample = 0.0f;
    float mNextSample = 0.0f;
};
