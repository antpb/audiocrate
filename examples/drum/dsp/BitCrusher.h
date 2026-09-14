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

        // Bit crushing setup — use 2^n levels so step size is exactly 1 LSB
        float quantLevels    = powf(2.0f, bitDepth);
        float invQuantLevels = 1.0f / quantLevels;
        // One quantization step in normalised amplitude. Used by the noise
        // floor gate to fade out the effect as the signal approaches silence.
        float lsbFloor = 1.0f / quantLevels;

        // Sample rate reduction frequency (0 = very low, 1 = bypass)
        float frequency = sampleRateParam;
        CONSTRAIN(frequency, 0.001f, 1.0f);

        float sample = mSample;
        float phase  = mPhase;

        // ≤ 8 bit: Game Boy / vintage harsh mode
        //   • truncation — asymmetric bias, vintage DAC distortion character
        //   • raw sample-and-hold — no anti-aliasing, hard staircase edges
        // > 8 bit: S950 clean mode (12-bit is the S950 sweet spot)
        //   • round-to-nearest — standard linear PCM ADC behaviour
        //   • BLEP-smoothed S&H — approximates the S950's output reconstruction filter
        const bool harshMode = (bitDepth <= 8.0f);

        float previous_sample = mPreviousSample;
        float next_sample     = mNextSample;

        for (int i = 0; i < n; ++i) {
            float dry   = buf[i];
            float input = dry;

            // ---- Bit Crushing ----
            if (bitDepth < 15.9f) {
                float scaled = (input * 0.5f + 0.5f) * quantLevels;
                if (harshMode) {
                    scaled = floorf(scaled);                          // truncate: vintage grit
                    if (scaled >= quantLevels) scaled = quantLevels - 1.0f;
                } else {
                    scaled = floorf(scaled + 0.5f);                  // round: S950 fidelity
                }
                input = (scaled * invQuantLevels) * 2.0f - 1.0f;
            }

            // ---- Sample Rate Reduction ----
            if (frequency < 0.999f) {
                if (harshMode) {
                    // Raw S&H: hard hold, no anti-aliasing.
                    // The staircase aliasing IS the Game Boy character.
                    phase += frequency;
                    if (phase >= 1.0f) {
                        phase -= 1.0f;
                        sample = input;
                    }
                    input = sample;
                } else {
                    // BLEP-smoothed S&H: softens the hold transitions,
                    // closer to the S950's output reconstruction filter.
                    float this_sample = next_sample;
                    next_sample = 0.0f;
                    phase += frequency;
                    if (phase >= 1.0f) {
                        phase -= 1.0f;
                        float t = phase / frequency;
                        float new_sample = previous_sample + (input - previous_sample) * (1.0f - t);
                        float discontinuity = new_sample - sample;
                        this_sample += discontinuity * stmlib::ThisBlepSample(t);
                        next_sample  += discontinuity * stmlib::NextBlepSample(t);
                        sample = new_sample;
                    }
                    next_sample  += sample;
                    previous_sample = input;
                    input = this_sample;
                }
            }

            // ---- Noise floor gate ----
            // Truncation lifts near-silence to the LSB floor, making quiet
            // decay tails sound like a noise channel. When the original sample
            // falls below one quantization step, blend the processed signal
            // back toward dry so the noise floor tracks the signal rather than
            // filling in silence at a fixed level.
            if (bitDepth < 15.9f) {
                const float dryAbs = fabsf(dry);
                if (dryAbs < lsbFloor) {
                    const float g = dryAbs / lsbFloor;
                    input = dry * (1.0f - g) + input * g;
                }
            }

            // ---- Dry/Wet Mix ----
            buf[i] = dry * (1.0f - mix) + input * mix;
        }

        mPhase          = phase;
        mSample         = sample;
        mNextSample     = next_sample;
        mPreviousSample = previous_sample;
    }

private:
    float mPhase = 0.0f;
    float mSample = 0.0f;
    float mPreviousSample = 0.0f;
    float mNextSample = 0.0f;
};
