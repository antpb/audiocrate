//
//  StmlibCompat.h
//  homecrate synth
//
//  Extracted helpers from Mutable Instruments stmlib for band-limited
//  oscillator synthesis. Provides POLYBLEP functions, parameter interpolation,
//  and sine lookup table without requiring the full stmlib dependency.
//
//  Original code: Copyright 2012-2016 Emilie Gillet, MIT License.
//

#pragma once

#include <cmath>
#include <cstddef>
#include <algorithm>

// CONSTRAIN macro from stmlib
#ifndef CONSTRAIN
#define CONSTRAIN(var, min, max) \
    if (var < (min)) var = (min); \
    if (var > (max)) var = (max);
#endif

namespace stmlib {

// ---- PolyBLEP anti-aliasing functions ----
// These reduce aliasing at waveform discontinuities.
// t is the fractional position of the discontinuity within the current sample.

inline float ThisBlepSample(float t) {
    return 0.5f * t * t;
}

inline float NextBlepSample(float t) {
    t = 1.0f - t;
    return -0.5f * t * t;
}

inline float ThisIntegratedBlepSample(float t) {
    return 0.5f * t * t * (1.0f - t * (2.0f / 3.0f));
}

inline float NextIntegratedBlepSample(float t) {
    float t2 = 1.0f - t;
    return 0.5f * t2 * t2 * (1.0f - t2 * (2.0f / 3.0f));
}

// ---- Parameter Interpolator ----
// Linearly interpolates a parameter over a block of samples.

class ParameterInterpolator {
public:
    ParameterInterpolator(float* state, float new_value, size_t size) {
        state_ = state;
        value_ = *state;
        increment_ = (new_value - *state) / static_cast<float>(size);
    }

    ParameterInterpolator() : state_(nullptr), value_(0.0f), increment_(0.0f) {}

    ~ParameterInterpolator() {
        if (state_) {
            *state_ = value_;
        }
    }

    inline float Next() {
        value_ += increment_;
        return value_;
    }

private:
    float* state_;
    float value_;
    float increment_;
};

}  // namespace stmlib

// ---- Sine Lookup Table ----
// 513-entry table (512 + 1 for interpolation guard point)

namespace synth_lut {

static constexpr int kSineTableSize = 512;

// Populated at first use via a static local
inline const float* getSineTable() {
    static float table[kSineTableSize + 1];
    static bool initialized = false;
    if (!initialized) {
        for (int i = 0; i <= kSineTableSize; ++i) {
            table[i] = static_cast<float>(
                sin(2.0 * M_PI * static_cast<double>(i) / static_cast<double>(kSineTableSize))
            );
        }
        initialized = true;
    }
    return table;
}

// Interpolated sine lookup: phase in [0, 1)
inline float SineLookup(float phase) {
    const float* table = getSineTable();
    float idx = phase * static_cast<float>(kSineTableSize);
    int i = static_cast<int>(idx);
    float frac = idx - static_cast<float>(i);
    i &= (kSineTableSize - 1);
    return table[i] + frac * (table[i + 1] - table[i]);
}

}  // namespace synth_lut
