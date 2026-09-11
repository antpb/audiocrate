//
//  DelayEngine.h
//  homecrate synth
//
//  Stereo delay with host BPM sync capability.
//  Header-only implementation.
//
//  Sync divisions:
//    0 = 1/4, 1 = 1/8, 2 = 1/16,
//    3 = 1/4 dotted, 4 = 1/8 dotted,
//    5 = 1/4 triplet, 6 = 1/8 triplet
//

#pragma once

#include <vector>
#include <cstring>
#include <algorithm>
#include <cmath>

class DelayEngine {
public:
    DelayEngine() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        // Max 2 seconds of delay
        int maxSamples = static_cast<int>(2.0 * sampleRate + 1);
        mBuffer.assign(maxSamples, 0.0f);
        mBufferSize = maxSamples;
        mWritePos = 0;
    }

    void reset() {
        std::fill(mBuffer.begin(), mBuffer.end(), 0.0f);
        mWritePos = 0;
    }

    // Calculate delay time in samples from BPM and sync division
    void updateFromBPM(double bpm, int syncDivision) {
        if (bpm <= 0.0) bpm = 120.0;

        static const float kDivisionMultipliers[] = {
            1.0f,    // 1/4
            0.5f,    // 1/8
            0.25f,   // 1/16
            1.5f,    // 1/4 dotted
            0.75f,   // 1/8 dotted
            0.667f,  // 1/4 triplet
            0.333f   // 1/8 triplet
        };

        int idx = std::clamp(syncDivision, 0, 6);
        float beatTime = 60.0f / static_cast<float>(bpm);
        float delaySeconds = beatTime * kDivisionMultipliers[idx];

        mDelayTimeSamples = static_cast<int>(delaySeconds * static_cast<float>(mSampleRate));
        mDelayTimeSamples = std::clamp(mDelayTimeSamples, 1, mBufferSize - 1);
    }

    // Set delay time directly in milliseconds (when not synced)
    void setDelayTimeMs(float ms) {
        mDelayTimeSamples = static_cast<int>(ms * 0.001f * static_cast<float>(mSampleRate));
        mDelayTimeSamples = std::clamp(mDelayTimeSamples, 1, mBufferSize - 1);
    }

    // Process a mono buffer in-place
    void process(float* buf, int n, float feedback, float mix) {
        if (mix < 0.0001f) return;

        feedback = std::clamp(feedback, 0.0f, 0.95f);
        float dry = 1.0f - mix;
        float wet = mix;

        for (int i = 0; i < n; ++i) {
            float input = buf[i];

            // Read from delay buffer
            int readPos = mWritePos - mDelayTimeSamples;
            if (readPos < 0) readPos += mBufferSize;

            float delayed = mBuffer[readPos];

            // Write input + feedback to buffer
            mBuffer[mWritePos] = input + delayed * feedback;

            // Mix
            buf[i] = input * dry + delayed * wet;

            if (++mWritePos >= mBufferSize) mWritePos = 0;
        }
    }

private:
    double mSampleRate = 48000.0;
    std::vector<float> mBuffer;
    int mBufferSize = 0;
    int mWritePos = 0;
    int mDelayTimeSamples = 12000;  // ~250ms at 48kHz
};
