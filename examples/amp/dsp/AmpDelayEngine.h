//
//  AmpDelayEngine.h
//  homecrate amp
//
//  Stereo delay for the amp signal chain. Header-only (no Compile Sources
//  change needed), modeled on the synth's DelayEngine but extended:
//
//    - True-stereo lines with fractional (linearly-interpolated) reads and a
//      one-pole-slewed delay time, so TIME changes glide (tape-style pitch
//      swoosh) instead of clicking.
//    - PING-PONG: the mono-summed input feeds the LEFT line only and the
//      feedback CROSSES lines (L tail -> R line, R tail -> L line), so the
//      repeats alternate sides. Processed per-sample so the cross-feedback is
//      sample-accurate.
//    - TAPE: a slow LFO (~0.4 Hz, ~2 ms depth) wobbles the read head and the
//      time slew is lengthened, so time changes bend pitch like a varispeed
//      tape machine. The loop's soft clipper doubles as the tape saturation.
//    - DUCK: an instant-attack / ~200 ms-release envelope follower on the DRY
//      input ducks the wet signal while the player is playing and lets the
//      repeats bloom in the gaps (same one-pole follower DNA as the kernel's
//      computeReverbGateGains()).
//    - TONE: a one-pole low-pass INSIDE the feedback loop (1.5–9 kHz, same
//      norm->cutoff mapping as the reverb TONE), so repeats darken
//      progressively like an analog delay.
//    - OSCILLATE (runaway): while engaged the feedback target ramps to ~1.12
//      (>1) over ~100 ms. The per-write tanh soft clipper bounds the loop, so
//      the level builds into a saturated self-oscillation instead of blowing
//      up — and the buildup speed inherently follows the user's delay time.
//      On release the target ramps back to the user feedback and the tail
//      decays naturally.
//    - BPM sync: updateFromBPM() maps the host tempo through the same 7
//      divisions as the synth (1/4, 1/8, 1/16, dotted, triplet).
//
//  All buffers are allocated in init() — never on the render thread. Both
//  processMono() and processStereo() are alloc-free.
//
//  Sync divisions:
//    0 = 1/4, 1 = 1/8, 2 = 1/16,
//    3 = 1/4 dotted, 4 = 1/8 dotted,
//    5 = 1/4 triplet, 6 = 1/8 triplet
//

#pragma once

#include <vector>
#include <algorithm>
#include <cmath>

class AmpDelayEngine {
public:
    AmpDelayEngine() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        // 2 s of delay + headroom for the tape wobble excursion.
        mBufferSize = static_cast<int>(kMaxDelaySeconds * sampleRate) + 256;
        mBufL.assign(mBufferSize, 0.0f);
        mBufR.assign(mBufferSize, 0.0f);
        mWritePos = 0;

        // Per-sample one-pole coefficients at this rate.
        mTimeSlewNormal = onePole(0.080);
        mTimeSlewTape   = onePole(0.250);
        mFbSlew         = onePole(0.100);
        mDuckRelease    = onePole(0.200);
        mLfoInc         = static_cast<float>(2.0 * M_PI * kTapeLfoHz / sampleRate);
        mMaxReadSamples = static_cast<float>(mBufferSize - 4);

        setTimeMs(mTimeMs);
        mTimeSmooth = mTimeTargetSamples;   // no glide on the very first block
        setToneNorm(mToneNorm);
    }

    void reset() {
        std::fill(mBufL.begin(), mBufL.end(), 0.0f);
        std::fill(mBufR.begin(), mBufR.end(), 0.0f);
        mWritePos  = 0;
        mToneL     = 0.0f;
        mToneR     = 0.0f;
        mDuckEnv   = 0.0f;
        mFbSmooth  = mFeedback;
        mTimeSmooth = mTimeTargetSamples;
        mLfoPhase  = 0.0f;
    }

    // ── Parameter setters (call from the render thread's once-per-block refresh) ──

    void setTimeMs(float ms) {
        mTimeMs = ms;
        mTimeTargetSamples = clampReadSamples(ms * 0.001f * static_cast<float>(mSampleRate));
    }

    void updateFromBPM(double bpm, int syncDivision) {
        if (bpm <= 0.0) bpm = 120.0;
        static const float kDivisionMultipliers[7] = {
            1.0f, 0.5f, 0.25f, 1.5f, 0.75f, 0.667f, 0.333f
        };
        const int   idx = std::clamp(syncDivision, 0, 6);
        const float beatTime = 60.0f / static_cast<float>(bpm);
        const float seconds  = beatTime * kDivisionMultipliers[idx];
        mTimeTargetSamples = clampReadSamples(seconds * static_cast<float>(mSampleRate));
    }

    void setFeedback(float fb)   { mFeedback = std::clamp(fb, 0.0f, 0.95f); }
    void setMix(float mix)       { mMix = std::clamp(mix, 0.0f, 1.0f); }

    // 0 → 1.5 kHz (dark) … 1 → 9 kHz (bright), same mapping as the reverb TONE.
    void setToneNorm(float norm) {
        mToneNorm = std::clamp(norm, 0.0f, 1.0f);
        const float cutoff = 1500.0f * std::pow(9000.0f / 1500.0f, mToneNorm);
        mToneCoef = onePole(1.0 / (2.0 * M_PI * static_cast<double>(cutoff)));
    }

    void setPingPong(bool on)    { mPingPong = on; }
    void setTape(bool on)        { mTape = on; }
    void setDuck(bool on)        { mDuck = on; }
    void setOscillate(bool on)   { mOscillate = on; }

    bool isOscillating() const   { return mOscillate; }

    // ── Render ────────────────────────────────────────────────────────────────

    // Mid-chain mono seam (pre-reverb / post-reverb inside a mono chain).
    // Uses the LEFT line only; ping-pong has no meaning on a mono bus, so the
    // feedback stays in-line regardless of the toggle.
    void processMono(float* buf, int n) {
        const float timeSlew = mTape ? mTimeSlewTape : mTimeSlewNormal;
        const float fbTarget = mOscillate ? kOscFeedback : mFeedback;

        for (int i = 0; i < n; ++i) {
            const float dry = buf[i];

            mTimeSmooth += timeSlew * (mTimeTargetSamples - mTimeSmooth);
            mFbSmooth   += mFbSlew  * (fbTarget - mFbSmooth);

            const float readOffset = currentReadOffset();
            float d = readFrac(mBufL, readOffset);

            mToneL += mToneCoef * (d - mToneL);
            d = mToneL;

            mBufL[mWritePos] = std::tanh(dry + d * mFbSmooth);

            buf[i] = dry * (1.0f - mMix) + d * mMix * duckGain(std::fabs(dry));

            advance();
        }
    }

    // Full stereo seam (chain end, or any seam in stereo mode). Per-sample so
    // the ping-pong cross-feedback is sample-accurate.
    void processStereo(float* L, float* R, int n) {
        const float timeSlew = mTape ? mTimeSlewTape : mTimeSlewNormal;
        const float fbTarget = mOscillate ? kOscFeedback : mFeedback;

        for (int i = 0; i < n; ++i) {
            const float dryL = L[i];
            const float dryR = R[i];

            mTimeSmooth += timeSlew * (mTimeTargetSamples - mTimeSmooth);
            mFbSmooth   += mFbSlew  * (fbTarget - mFbSmooth);

            const float readOffset = currentReadOffset();
            float dL = readFrac(mBufL, readOffset);
            float dR = readFrac(mBufR, readOffset);

            mToneL += mToneCoef * (dL - mToneL);
            mToneR += mToneCoef * (dR - mToneR);
            dL = mToneL;
            dR = mToneR;

            if (mPingPong) {
                // Mono-summed input into the LEFT line only; tails cross lines
                // so the repeats alternate L → R → L …
                const float inMono = 0.5f * (dryL + dryR);
                mBufL[mWritePos] = std::tanh(inMono + dR * mFbSmooth);
                mBufR[mWritePos] = std::tanh(dL * mFbSmooth);
            } else {
                mBufL[mWritePos] = std::tanh(dryL + dL * mFbSmooth);
                mBufR[mWritePos] = std::tanh(dryR + dR * mFbSmooth);
            }

            const float wetGain = mMix * duckGain(std::max(std::fabs(dryL), std::fabs(dryR)));
            L[i] = dryL * (1.0f - mMix) + dL * wetGain;
            R[i] = dryR * (1.0f - mMix) + dR * wetGain;

            advance();
        }
    }

private:
    static constexpr double kMaxDelaySeconds = 2.0;
    static constexpr float  kOscFeedback     = 1.12f;   // runaway target (>1, tanh-bounded)
    static constexpr double kTapeLfoHz       = 0.4;
    static constexpr float  kTapeLfoDepthMs  = 2.0f;
    static constexpr float  kDuckDepth       = 0.85f;   // how far the wet ducks while playing
    static constexpr float  kDuckSensitivity = 12.0f;   // env → duck-amount scale

    float onePole(double seconds) const {
        const double t = std::max(seconds, 1e-6);
        return static_cast<float>(1.0 - std::exp(-1.0 / (t * mSampleRate)));
    }

    float clampReadSamples(float samples) const {
        return std::clamp(samples, 1.0f, mMaxReadSamples > 0.0f ? mMaxReadSamples : 1.0f);
    }

    // Smoothed delay time + tape wobble, clamped inside the buffer.
    float currentReadOffset() {
        float offset = mTimeSmooth;
        if (mTape) {
            offset += kTapeLfoDepthMs * 0.001f * static_cast<float>(mSampleRate)
                    * std::sin(mLfoPhase);
            mLfoPhase += mLfoInc;
            if (mLfoPhase > static_cast<float>(2.0 * M_PI))
                mLfoPhase -= static_cast<float>(2.0 * M_PI);
        }
        return clampReadSamples(offset);
    }

    // Fractional (linear-interp) read at writePos - offset.
    float readFrac(const std::vector<float>& buf, float offset) const {
        float pos = static_cast<float>(mWritePos) - offset;
        if (pos < 0.0f) pos += static_cast<float>(mBufferSize);
        const int   i0   = static_cast<int>(pos);
        const float frac = pos - static_cast<float>(i0);
        const int   i1   = (i0 + 1 < mBufferSize) ? i0 + 1 : 0;
        return buf[i0] + frac * (buf[i1] - buf[i0]);
    }

    // Instant-attack / ~200 ms-release follower on the dry level; returns the
    // gain applied to the wet signal (1 when idle, ducked while playing).
    float duckGain(float dryLevel) {
        if (!mDuck) return 1.0f;
        if (dryLevel > mDuckEnv) mDuckEnv = dryLevel;
        else                     mDuckEnv += mDuckRelease * (dryLevel - mDuckEnv);
        const float amount = std::min(1.0f, mDuckEnv * kDuckSensitivity);
        return 1.0f - kDuckDepth * amount;
    }

    void advance() {
        if (++mWritePos >= mBufferSize) mWritePos = 0;
    }

    double mSampleRate = 48000.0;
    std::vector<float> mBufL;
    std::vector<float> mBufR;
    int   mBufferSize = 0;
    int   mWritePos   = 0;

    // User parameters.
    float mTimeMs   = 350.0f;
    float mFeedback = 0.35f;
    float mMix      = 0.0f;
    float mToneNorm = 0.7f;
    bool  mPingPong = false;
    bool  mTape     = false;
    bool  mDuck     = false;
    bool  mOscillate = false;

    // Derived / smoothed state.
    float mTimeTargetSamples = 16800.0f;   // 350 ms @ 48 kHz
    float mTimeSmooth        = 16800.0f;
    float mMaxReadSamples    = 0.0f;
    float mTimeSlewNormal    = 0.001f;
    float mTimeSlewTape      = 0.0003f;
    float mFbSmooth          = 0.35f;
    float mFbSlew            = 0.001f;
    float mToneCoef          = 0.5f;
    float mToneL             = 0.0f;
    float mToneR             = 0.0f;
    float mDuckEnv           = 0.0f;
    float mDuckRelease       = 0.0003f;
    float mLfoPhase          = 0.0f;
    float mLfoInc            = 0.0f;
};
