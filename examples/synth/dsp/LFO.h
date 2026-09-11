//
//  LFO.h
//  homecrate synth
//
//  Low Frequency Oscillator for parameter modulation.
//  Header-only. Produces a bipolar (-1..+1) output value.
//
//  Shapes: Sine, Triangle, Saw Up, Saw Down, Square, S&H (Random)
//

#pragma once

#include "StmlibCompat.h"
#include <cstdlib>

class LFO {
public:
    enum Shape { Sine = 0, Triangle, SawUp, SawDown, Square, SampleAndHold, ShapeCount };

    enum Destination {
        Off = 0,
        FilterCutoff,
        OscAPitch,
        OscBPitch,
        OscBlend,
        Amp,
        Pan,
        OscAShape,
        OscBShape,
        DestinationCount
    };

    LFO() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        mPhase = 0.0f;
        mValue = 0.0f;
        mHeldValue = 0.0f;
    }

    void setRate(float hz) { mRate = hz; }
    void setDepth(float depth) { mDepth = depth; }
    void setShape(int shape) { mShape = static_cast<Shape>(shape % ShapeCount); }
    void setDestination(int dest) { mDestination = static_cast<Destination>(dest % DestinationCount); }

    Destination destination() const { return mDestination; }
    float depth() const { return mDepth; }

    // Advance the LFO by a number of samples and return the current modulation value (-1..+1) * depth
    float process(int numSamples) {
        if (mDestination == Off || mDepth < 0.0001f) return 0.0f;

        float phaseInc = mRate / static_cast<float>(mSampleRate) * static_cast<float>(numSamples);
        mPhase += phaseInc;

        // Wrap phase
        if (mPhase >= 1.0f) {
            mPhase -= static_cast<int>(mPhase);
            // New S&H value at each cycle
            if (mShape == SampleAndHold) {
                mHeldValue = (static_cast<float>(rand()) / static_cast<float>(RAND_MAX)) * 2.0f - 1.0f;
            }
        }

        float raw = 0.0f;
        switch (mShape) {
            case Sine:
                raw = synth_lut::SineLookup(mPhase);
                break;
            case Triangle:
                raw = (mPhase < 0.5f)
                    ? (4.0f * mPhase - 1.0f)
                    : (3.0f - 4.0f * mPhase);
                break;
            case SawUp:
                raw = 2.0f * mPhase - 1.0f;
                break;
            case SawDown:
                raw = 1.0f - 2.0f * mPhase;
                break;
            case Square:
                raw = (mPhase < 0.5f) ? 1.0f : -1.0f;
                break;
            case SampleAndHold:
                raw = mHeldValue;
                break;
            default:
                break;
        }

        mValue = raw * mDepth;
        return mValue;
    }

    float currentValue() const { return mValue; }

private:
    double mSampleRate = 44100.0;
    float mRate = 1.0f;       // Hz
    float mDepth = 0.0f;      // 0..1
    Shape mShape = Sine;
    Destination mDestination = Off;

    float mPhase = 0.0f;
    float mValue = 0.0f;
    float mHeldValue = 0.0f;
};
