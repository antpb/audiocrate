//
//  ChorusEngine.h
//  homecrate synth
//
//  3-voice chorus effect with LFO-modulated delay lines.
//  Simplified from Mutable Instruments Plaits ensemble.h.
//  Header-only implementation.
//
//  Parameters:
//    rate:  0..1 (LFO speed)
//    depth: 0..1 (modulation depth)
//    mix:   0..1 (dry/wet)
//

#pragma once

#include "StmlibCompat.h"
#include <vector>
#include <cstring>

class ChorusEngine {
public:
    ChorusEngine() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        // Max delay ~30ms
        int maxDelay = static_cast<int>(0.03 * sampleRate + 1);
        mBuffer.assign(maxDelay, 0.0f);
        mBufferSize = maxDelay;
        mWritePos = 0;

        // LFO phases offset by 120 degrees
        mLfoPhase[0] = 0.0f;
        mLfoPhase[1] = 1.0f / 3.0f;
        mLfoPhase[2] = 2.0f / 3.0f;
    }

    void reset() {
        std::fill(mBuffer.begin(), mBuffer.end(), 0.0f);
        mWritePos = 0;
    }

    // Process a mono buffer in-place
    void process(float* buf, int n, float rate, float depth, float mix) {
        if (mix < 0.0001f) return;

        // LFO rate: 0.1 Hz to 8 Hz
        float lfoFreq = (0.1f + rate * 7.9f) / static_cast<float>(mSampleRate);

        // Delay range: 1ms to 15ms
        float minDelay = 0.001f * static_cast<float>(mSampleRate);
        float maxDelay = 0.015f * static_cast<float>(mSampleRate);
        float delayRange = (maxDelay - minDelay) * depth;

        float dry = 1.0f - mix * 0.5f;
        float wet = mix / 3.0f;  // Divide by 3 voices

        for (int i = 0; i < n; ++i) {
            float input = buf[i];

            // Write to delay buffer
            mBuffer[mWritePos] = input;

            float chorusSum = 0.0f;

            // Read from 3 modulated delay taps
            for (int v = 0; v < 3; ++v) {
                // LFO value (sine)
                float lfo = synth_lut::SineLookup(mLfoPhase[v]);

                // Delay time in samples
                float delaySamples = minDelay + delayRange * (0.5f + 0.5f * lfo);

                // Read with linear interpolation
                float readPos = static_cast<float>(mWritePos) - delaySamples;
                if (readPos < 0.0f) readPos += static_cast<float>(mBufferSize);

                int idx0 = static_cast<int>(readPos);
                float frac = readPos - static_cast<float>(idx0);
                int idx1 = idx0 + 1;
                if (idx0 >= mBufferSize) idx0 -= mBufferSize;
                if (idx1 >= mBufferSize) idx1 -= mBufferSize;
                if (idx0 < 0) idx0 += mBufferSize;
                if (idx1 < 0) idx1 += mBufferSize;

                float delayed = mBuffer[idx0] + frac * (mBuffer[idx1] - mBuffer[idx0]);
                chorusSum += delayed;

                // Advance LFO
                mLfoPhase[v] += lfoFreq;
                if (mLfoPhase[v] >= 1.0f) mLfoPhase[v] -= 1.0f;
            }

            buf[i] = input * dry + chorusSum * wet;

            if (++mWritePos >= mBufferSize) mWritePos = 0;
        }
    }

private:
    double mSampleRate = 48000.0;
    std::vector<float> mBuffer;
    int mBufferSize = 0;
    int mWritePos = 0;
    float mLfoPhase[3] = {};
};
