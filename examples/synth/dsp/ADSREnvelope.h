//
//  ADSREnvelope.h
//  homecrate synth
//
//  Per-sample ADSR envelope generator. Header-only implementation.
//  Produces a 0..1 envelope value each sample.
//

#pragma once

#include <cmath>
#include <algorithm>

class ADSREnvelope {
public:
    enum Stage { Idle, Attack, Decay, Sustain, Release };

    ADSREnvelope() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        mStage = Idle;
        mValue = 0.0f;
        recalcRates();
    }

    void noteOn() {
        mStage = Attack;
        // Don't reset value — allows retriggering from current position
    }

    void noteOff() {
        if (mStage != Idle) {
            mStage = Release;
        }
    }

    void kill() {
        mStage = Idle;
        mValue = 0.0f;
    }

    // Process one sample, returns envelope value [0, 1]
    inline float process() {
        switch (mStage) {
            case Attack:
                mValue += mAttackRate;
                if (mValue >= 1.0f) {
                    mValue = 1.0f;
                    mStage = Decay;
                }
                break;

            case Decay:
                mValue -= mDecayRate;
                if (mValue <= mSustainLevel) {
                    mValue = mSustainLevel;
                    mStage = Sustain;
                }
                break;

            case Sustain:
                mValue = mSustainLevel;
                break;

            case Release:
                mValue -= mReleaseRate;
                if (mValue <= 0.0f) {
                    mValue = 0.0f;
                    mStage = Idle;
                }
                break;

            case Idle:
            default:
                mValue = 0.0f;
                break;
        }

        return mValue;
    }

    bool isActive() const { return mStage != Idle; }
    Stage stage() const { return mStage; }
    float value() const { return mValue; }

    void setAttack(float seconds) {
        seconds = std::max(0.001f, seconds);
        if (seconds == mAttackTime) return;
        mAttackTime = seconds;
        mAttackRate = 1.0f / (mAttackTime * static_cast<float>(mSampleRate));
    }

    void setDecay(float seconds) {
        seconds = std::max(0.001f, seconds);
        if (seconds == mDecayTime) return;
        mDecayTime = seconds;
        mDecayRate = 1.0f / (mDecayTime * static_cast<float>(mSampleRate));
    }

    void setSustain(float level) {
        level = std::clamp(level, 0.0f, 1.0f);
        if (level == mSustainLevel) return;
        mSustainLevel = level;
        // If currently sustaining, update immediately
        if (mStage == Sustain) {
            mValue = mSustainLevel;
        }
    }

    void setRelease(float seconds) {
        seconds = std::max(0.001f, seconds);
        if (seconds == mReleaseTime) return;
        mReleaseTime = seconds;
        mReleaseRate = 1.0f / (mReleaseTime * static_cast<float>(mSampleRate));
    }

    void setSampleRate(double sr) {
        mSampleRate = sr;
        recalcRates();
    }

private:
    void recalcRates() {
        mAttackRate  = 1.0f / (mAttackTime  * static_cast<float>(mSampleRate));
        mDecayRate   = 1.0f / (mDecayTime   * static_cast<float>(mSampleRate));
        mReleaseRate = 1.0f / (mReleaseTime * static_cast<float>(mSampleRate));
    }

    Stage  mStage        = Idle;
    float  mValue        = 0.0f;
    double mSampleRate   = 48000.0;

    float mAttackTime    = 0.01f;
    float mDecayTime     = 0.3f;
    float mSustainLevel  = 0.7f;
    float mReleaseTime   = 0.5f;

    float mAttackRate    = 0.0f;
    float mDecayRate     = 0.0f;
    float mReleaseRate   = 0.0f;
};
