//
//  LofiEngine.h
//  homecrate grain
//
//  Lo-fi degradation suite: tape warble → pitch-tracked ring-mod carrier →
//  mic coloration (incl. an f0-tuned RESONATOR) → bit/rate crush → media
//  noise, with TRANSMIT (inverse-envelope "failing link" physics) and an
//  LFO hook driven by the kernel. Header-only.
//
//  Internal order (deliberate): WARBLE models the transport before the mic;
//  CARRIER sidebands get shaped by the mic band like a receiver; the
//  mic band is what gets digitally mangled (radio-through-a-crusher, not
//  crusher-through-a-radio); NOISE sits on the "medium", uncrushed.
//
//  RT safety: every buffer is a fixed std::array read through pow-of-2 masks
//  or clamped fractional taps — no std::vector on the audio path, nothing to
//  size against maxFrames (the engine chunks internally). All coefficient
//  work is hoisted per chunk. No rand(): xorshift32 members. Feedback combs
//  are hard-clamped ≤ 0.65 so they cannot run away; the kernel's FX scrubber
//  resets the whole engine if anything upstream poisons a block.
//

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

#include "SVFilter.h"
#include "BitCrusher.h"

class LofiEngine {
public:
    // Mirrors of the lofi parameter cluster, pushed once per block by
    // refreshLofi(). Enum meanings match Parameters.swift valueStrings.
    struct Params {
        int   micType     = 0;    // 0 OFF / 1 TELEPHONE / 2 CB RADIO / 3 MEGAPHONE / 4 TIN CAN / 5 RESONATOR
        float micAmount   = 1.f;  // 0–1 morph mild → full
        float crush       = 0.f;  // 0–1 macro (bit depth + rate reduction)
        int   noiseType   = 0;    // 0 HISS / 1 CRACKLE / 2 HUM
        float noiseAmount = 0.f;  // 0–1
        float warble      = 0.f;  // 0–1 wow(+flutter past 0.4)
        float carrier     = 0.f;  // 0–1 ring-mod amount
        int   carrierMode = 0;    // 0 AM RADIO / 1 SUB / 2 UNISON / 3 FIFTH / 4 OCTAVE
        float transmit    = 0.f;  // 0–1 failing-link amount
        float mix         = 1.f;  // section dry/wet crossfade
        int   lfoTarget   = 0;    // 0 OFF / 1 CRUSH / 2 FILTER / 3 WARBLE / 4 DROPOUT / 5 CARRIER
        float lfoDepth    = 0.f;  // 0–1
    };

    // Per-block dynamic inputs the kernel owns: the shaped LFO value at block
    // start/end (engine ramps linearly between them) and the pitch tracker's
    // latest measurement (f0Hz <= 0 = unvoiced; the engine holds the last
    // valid f0 for the RESONATOR and fades the tracked carrier out).
    struct Block {
        float lfo0 = 0.f;   // [-1, 1]
        float lfo1 = 0.f;   // [-1, 1]
        float f0Hz = 0.f;   // detected fundamental, Hz; <= 0 when unvoiced
    };

    void init(double sampleRate, uint32_t seed) {
        mSampleRate = (sampleRate > 1000.0) ? sampleRate : 48000.0;
        mRng = (seed == 0) ? 0x9E3779B9u : seed;
        mHP.init(mSampleRate);  mHP.setType(SVFilter::HighPass);
        mLP.init(mSampleRate);  mLP.setType(SVFilter::LowPass);
        mPeak.init(mSampleRate); mPeak.setType(SVFilter::BandPass);
        mCrackleBP.init(mSampleRate); mCrackleBP.setType(SVFilter::BandPass);
        mCrackleBP.setCutoff(3000.f); mCrackleBP.setResonance(0.4f);
        // Pre-warm the shared sine LUT off the render thread (its table is
        // lazily built on first use).
        (void)synth_lut::SineLookup(0.25f);
        reset();
    }

    void reset() {
        mWarbleRing.fill(0.f);
        mComb1.fill(0.f);
        mComb2.fill(0.f);
        mWarbleWrite = 0;
        mCombWrite = 0;
        mWowPhase = 0.f;
        mFlutterPhase = 0.f;
        mCarrierPhase = 0.f;
        mCarrierHzState = 0.f;
        mHeldF0 = 130.f;
        mVoicedRamp = 0.f;
        mCombD1State = 0.f;
        mCombD2State = 0.f;
        mEnv = 0.f;
        mEnvSlow = 0.f;
        mFail = 0.f;
        mDropGain = 1.f;
        mDropHold = 0;
        mCrackleEnergy = 0.f;
        mHissLPState = 0.f;
        mHumPhase1 = 0.f;
        mHumPhase2 = 0.f;
        mCrushWasOn = false;
        mHP.reset();
        mLP.reset();
        mPeak.reset();
        mCrackleBP.reset();
        mCrusher.init();
    }

    // In-place mono processing. Chunked internally so the dry scratch stays a
    // fixed array regardless of the host's maxFrames.
    void process(float* buf, int n, const Params& p, const Block& blk) {
        if (n <= 0) return;

        // Hold-last f0 for the tracked modes; ramp the "voiced" confidence so
        // consonants/breaths fade the carrier instead of clanging it.
        if (blk.f0Hz > 20.f) mHeldF0 = std::clamp(blk.f0Hz, 40.f, 1200.f);
        const float voicedTarget = (blk.f0Hz > 20.f) ? 1.f : 0.f;

        int done = 0;
        while (done < n) {
            const int m = std::min(kChunk, n - done);
            const float t0 = static_cast<float>(done) / static_cast<float>(n);
            const float t1 = static_cast<float>(done + m) / static_cast<float>(n);
            const float lfoA = blk.lfo0 + (blk.lfo1 - blk.lfo0) * t0;
            const float lfoB = blk.lfo0 + (blk.lfo1 - blk.lfo0) * t1;
            processChunk(buf + done, m, p, lfoA, lfoB, voicedTarget);
            done += m;
        }
    }

private:
    static constexpr int kChunk          = 128;
    static constexpr int kWarbleSize     = 2048;   // 21 ms @ 96k, pow2
    static constexpr int kWarbleMask     = kWarbleSize - 1;
    static constexpr int kCombSize       = 2048;   // resonator reaches ~47 Hz @ 96k
    static constexpr int kCombMask       = kCombSize - 1;

    // ── Mic mode table ────────────────────────────────────────────────────────
    // "Full" values at micAmount = 1; the morph widens the band and relaxes
    // drive/comb feedback toward neutral as the amount falls.
    struct MicMode {
        float hpHz;      // band low edge
        float lpHz;      // band high edge
        float peakHz;    // resonant presence peak (0 = none)
        float peakQ;     // SVF resonance 0–1
        float peakGain;  // parallel BP add
        float drivePre;  // tanh pre-gain span (pre = 1 + drivePre·amt)
        float combMs1;   // series feedback combs (0 = unused)
        float combMs2;
        float combFB;    // per-comb feedback at amt = 1 (clamped ≤ 0.65)
    };
    static const MicMode& micMode(int type) {
        //                              hp     lp     peak   pQ    pG    drv  c1ms  c2ms   cFB
        static const MicMode kOff       {  0.f, 20000.f,    0.f, 0.0f, 0.0f, 0.f, 0.f,  0.f,  0.f  };
        static const MicMode kTelephone {300.f,  3400.f, 1700.f, 0.5f, 0.6f, 3.f, 0.f,  0.f,  0.f  };
        static const MicMode kCBRadio   {400.f,  2500.f, 2100.f, 0.7f, 1.1f, 7.f, 0.f,  0.f,  0.f  };
        static const MicMode kMegaphone {500.f,  4000.f, 1800.f, 0.6f, 1.0f, 12.f, 1.2f, 0.f,  0.35f};
        static const MicMode kTinCan    {250.f,  5000.f, 2800.f, 0.6f, 0.8f, 4.f, 1.1f, 0.47f, 0.55f};
        static const MicMode kResonator {250.f,  5000.f, 2800.f, 0.5f, 0.5f, 4.f, 0.f,  0.f,  0.6f };
        switch (type) {
            case 1:  return kTelephone;
            case 2:  return kCBRadio;
            case 3:  return kMegaphone;
            case 4:  return kTinCan;
            case 5:  return kResonator;
            default: return kOff;
        }
    }

    inline float nextRand() {   // xorshift32 → [-1, 1]
        mRng ^= mRng << 13; mRng ^= mRng >> 17; mRng ^= mRng << 5;
        return static_cast<float>(mRng >> 8) * (2.0f / 16777216.0f) - 1.0f;
    }

    // Clamped fractional ring read (iOS 26 hardened-libc++ discipline: masked
    // indices only, offset clamped to the ring span).
    template <size_t N>
    inline float readFrac(const std::array<float, N>& ring, int writePos, float offset) const {
        const float maxOff = static_cast<float>(N - 2);
        offset = std::clamp(offset, 1.f, maxOff);
        float pos = static_cast<float>(writePos) - offset;
        const int   i0   = static_cast<int>(std::floor(pos));
        const float frac = pos - static_cast<float>(i0);
        const float s0 = ring[static_cast<size_t>(i0 & static_cast<int>(N - 1))];
        const float s1 = ring[static_cast<size_t>((i0 + 1) & static_cast<int>(N - 1))];
        return s0 + frac * (s1 - s0);
    }

    void processChunk(float* buf, int m, const Params& p,
                      float lfoA, float lfoB, float voicedTarget) {
        const float sr = static_cast<float>(mSampleRate);
        const float lfoMid   = 0.5f * (lfoA + lfoB);
        const float lfoMid01 = 0.5f * (lfoMid + 1.f);
        const float depth    = p.lfoDepth;

        // ── Envelope follower on the chunk input (drives noise duck, TRANSMIT
        // fail level, and consonant-spark crackle) ────────────────────────────
        const float envA  = 1.f - std::exp(-1.f / (0.005f * sr));   // 5 ms
        const float envR  = 1.f - std::exp(-1.f / (0.15f  * sr));   // 150 ms
        const float slowA = 1.f - std::exp(-1.f / (0.05f  * sr));   // 50 ms (transient ref)

        // ── TRANSMIT fail level (block-rate, 80 ms smoothing) ─────────────────
        constexpr float kFailThresh = 0.05f;   // ≈ −26 dBFS "strong signal"
        const float failTarget = p.transmit *
            (1.f - std::min(1.f, mEnv / kFailThresh));
        const float failCoef = 1.f - std::exp(-static_cast<float>(m) / (0.08f * sr));
        mFail += failCoef * (failTarget - mFail);
        const float fail = mFail;

        // ── Effective per-chunk amounts (LFO + TRANSMIT applied) ──────────────
        float warbleAmt  = std::clamp(p.warble  + (p.lfoTarget == 3 ? depth * lfoMid01 : 0.f), 0.f, 1.f);
        float crushAmt   = std::clamp(p.crush   + (p.lfoTarget == 1 ? depth * lfoMid01 : 0.f)
                                                + 0.6f * fail, 0.f, 1.f);
        float carrierAmt = std::clamp(p.carrier + (p.lfoTarget == 5 ? depth * lfoMid01 : 0.f), 0.f, 1.f);
        const float filterOct = (p.lfoTarget == 2) ? depth * lfoMid : 0.f;   // ±1 octave

        const bool warbleOn  = warbleAmt  > 0.001f;
        const bool carrierOn = carrierAmt > 0.001f && (p.carrierMode == 0 || mVoicedRamp > 0.001f || voicedTarget > 0.f);
        const bool micOn     = p.micType != 0 && p.micAmount > 0.001f;
        const bool crushOn   = crushAmt   > 0.001f;
        const bool noiseOn   = (p.noiseAmount > 0.001f) || fail > 0.01f;

        // ── Warble coefficients (wow 0.4 Hz + flutter 6.5 Hz) ─────────────────
        const float wowInc     = 0.4f  / sr;
        const float flutterInc = 6.5f  / sr;
        const float centerSmp  = 0.006f * sr;
        const float wowDepth   = warbleAmt * 0.0035f * sr;
        const float flutterDepth = std::max(0.f, warbleAmt - 0.4f) * 0.0006f * sr;

        // ── Carrier frequency (glided ~20 ms; voiced ramp 5 ms up / 50 ms down)
        float carrierHzTarget = 1170.f;   // AM RADIO heterodyne whine
        switch (p.carrierMode) {
            case 1: carrierHzTarget = mHeldF0 * 0.5f; break;   // SUB
            case 2: carrierHzTarget = mHeldF0;        break;   // UNISON
            case 3: carrierHzTarget = mHeldF0 * 1.5f; break;   // FIFTH
            case 4: carrierHzTarget = mHeldF0 * 2.0f; break;   // OCTAVE
            default: break;
        }
        if (mCarrierHzState <= 0.f) mCarrierHzState = carrierHzTarget;
        const float glide = 1.f - std::exp(-static_cast<float>(m) / (0.02f * sr));
        mCarrierHzState += glide * (carrierHzTarget - mCarrierHzState);
        const float carrierInc = mCarrierHzState / sr;
        const float vrUp   = 1.f - std::exp(-1.f / (0.005f * sr));
        const float vrDown = 1.f - std::exp(-1.f / (0.05f  * sr));

        // ── Mic coloration coefficients (per chunk) ───────────────────────────
        const MicMode& mode = micMode(p.micType);
        float combD1 = 0.f, combD2 = 0.f, combFB = 0.f;
        float micDrivePre = 1.f, micDriveComp = 1.f, peakGain = 0.f;
        if (micOn) {
            const float amt = p.micAmount;
            const float bandNarrow = 1.f + 2.f * fail;   // TRANSMIT narrows the band
            const float fScale = std::exp2(filterOct);   // LFO FILTER target
            float hp = (80.f + (mode.hpHz - 80.f) * amt) * bandNarrow * fScale;
            float lp = (mode.lpHz + (16000.f - mode.lpHz) * (1.f - amt)) / bandNarrow * fScale;
            lp = std::max(lp, hp * 1.5f);
            mHP.setCutoff(hp);
            mLP.setCutoff(lp);
            if (mode.peakHz > 0.f) {
                mPeak.setCutoff(std::clamp(mode.peakHz * fScale, 100.f, 12000.f));
                mPeak.setResonance(mode.peakQ);
                peakGain = mode.peakGain * amt;
            }
            micDrivePre  = 1.f + mode.drivePre * amt;
            micDriveComp = 0.25f / std::tanh(micDrivePre * 0.25f);

            if (p.micType == 5) {
                // RESONATOR: combs tuned to the held f0 (+ ×1.5 partner),
                // glided so note changes sweep instead of clicking.
                const float d1t = std::clamp(sr / mHeldF0,          16.f, static_cast<float>(kCombSize - 2));
                const float d2t = std::clamp(sr / (mHeldF0 * 1.5f), 16.f, static_cast<float>(kCombSize - 2));
                if (mCombD1State <= 0.f) { mCombD1State = d1t; mCombD2State = d2t; }
                const float dGlide = 1.f - std::exp(-static_cast<float>(m) / (0.03f * sr));
                mCombD1State += dGlide * (d1t - mCombD1State);
                mCombD2State += dGlide * (d2t - mCombD2State);
                combD1 = mCombD1State;
                combD2 = mCombD2State;
                combFB = std::min(0.6f * amt * (0.4f + 0.6f * mVoicedRamp), 0.65f);
            } else if (mode.combMs1 > 0.f) {
                combD1 = std::clamp(mode.combMs1 * 0.001f * sr, 4.f, static_cast<float>(kCombSize - 2));
                combD2 = (mode.combMs2 > 0.f)
                    ? std::clamp(mode.combMs2 * 0.001f * sr, 4.f, static_cast<float>(kCombSize - 2))
                    : 0.f;
                combFB = std::min(mode.combFB * amt, 0.65f);
            }
        }

        // ── Crush mapping (drum-proven log curve + DC-bias gain trim) ─────────
        // Off→on edge clears the crusher's held S&H sample so a knob-up never
        // replays stale content (BitCrusher::init is 4 float writes).
        if (crushOn && !mCrushWasOn) mCrusher.init();
        mCrushWasOn = crushOn;
        float crushBits = 16.f, crushSR = 1.f, crushMix = 0.f, crushTrim = 1.f;
        if (crushOn) {
            crushBits = 16.f - 12.f * crushAmt;
            const float srRatio = 1000.f / sr;
            crushSR  = (crushAmt <= 0.001f) ? 1.f : std::pow(srRatio, crushAmt);
            crushMix = std::min(1.f, crushAmt * 4.f);
            if (crushBits < 8.f)
                crushTrim = 0.75f + (std::max(crushBits, 4.f) - 4.f) * (0.25f / 4.f);
        }

        // ── Noise levels (vocal-ducked; TRANSMIT lifts the floor as the link
        // fails) ──────────────────────────────────────────────────────────────
        const float hissLP    = 1.f - std::exp(-2.f * static_cast<float>(M_PI) * 6000.f / sr);
        const float humInc1   = 60.f  / sr;
        const float humInc2   = 120.f / sr;
        const float noiseBase = p.noiseAmount;
        float noiseGainFull = 0.f;
        if (noiseOn) {
            const float amtN = std::max(noiseBase, 0.35f * fail);
            switch (p.noiseType) {
                case 1:  noiseGainFull = amtN;                                          break; // CRACKLE: per-impulse amp
                case 2:  noiseGainFull = std::pow(10.f, (-45.f + 25.f * amtN) / 20.f);  break; // HUM
                default: noiseGainFull = std::pow(10.f, (-40.f + 25.f * amtN) / 20.f);  break; // HISS
            }
        }
        constexpr float kDuckThresh = 0.02f;   // ≈ −34 dBFS
        const float crackleDecay = std::exp(-1.f / (0.0012f * sr));

        // ── Dropout (LFO DROPOUT target + TRANSMIT random dips), 2 ms smoother
        const float dropCoef = 1.f - std::exp(-1.f / (0.002f * sr));
        float dropTargetLfo = 1.f;
        if (p.lfoTarget == 4) dropTargetLfo = 1.f - depth * lfoMid01;
        if (fail > 0.01f && mDropHold <= 0) {
            // Random per-chunk chance of a 30–90 ms dip, scaled by fail².
            const float prob = fail * fail * 0.35f * (static_cast<float>(m) / (0.010f * sr));
            if (0.5f * (nextRand() + 1.f) < prob)
                mDropHold = static_cast<int>((0.03f + 0.03f * (nextRand() + 1.f)) * sr);
        }

        const float mix = std::clamp(p.mix, 0.f, 1.f);

        // ── Per-sample loop ───────────────────────────────────────────────────
        for (int i = 0; i < m; ++i) {
            const float dry = buf[i];
            float x = dry;

            // Envelope (on the stage input).
            const float a = std::abs(dry);
            mEnv     += (a > mEnv     ? envA  : envR)  * (a - mEnv);
            const float prevSlow = mEnvSlow;
            mEnvSlow += slowA * (a - mEnvSlow);
            const float transient = std::max(0.f, mEnvSlow - prevSlow);

            // 1. WARBLE — modulated fractional tap (doubler idiom). The ring
            // is written unconditionally while the section runs so a knob-up
            // never replays stale content.
            mWarbleRing[static_cast<size_t>(mWarbleWrite)] = x;
            if (warbleOn) {
                mWowPhase     += wowInc;     if (mWowPhase     >= 1.f) mWowPhase     -= 1.f;
                mFlutterPhase += flutterInc; if (mFlutterPhase >= 1.f) mFlutterPhase -= 1.f;
                const float off = centerSmp
                    + wowDepth     * synth_lut::SineLookup(mWowPhase)
                    + flutterDepth * synth_lut::SineLookup(mFlutterPhase);
                const float tap = readFrac(mWarbleRing, mWarbleWrite, off);
                const float wet = std::min(1.f, warbleAmt * 2.f);
                x += wet * (tap - x);
            }
            mWarbleWrite = (mWarbleWrite + 1) & kWarbleMask;

            // 2. CARRIER — pitch-tracked ring mod (voiced-ramp faded for the
            // tracked modes; AM RADIO ignores voicing — its whine is constant).
            mVoicedRamp = std::clamp(
                mVoicedRamp + (voicedTarget > 0.5f ? vrUp : -vrDown), 0.f, 1.f);
            if (carrierOn) {
                mCarrierPhase += carrierInc;
                if (mCarrierPhase >= 1.f) mCarrierPhase -= 1.f;
                const float amtEff = carrierAmt *
                    (p.carrierMode == 0 ? 1.f : mVoicedRamp);
                const float ring = x * synth_lut::SineLookup(mCarrierPhase);
                x += amtEff * (ring - x);
            }

            // 3. MIC COLOR — band (HP∘LP) + resonant peak + grit + combs.
            if (micOn) {
                float band = mLP.process(mHP.process(x));
                if (peakGain > 0.f)
                    band += peakGain * mPeak.process(band);
                if (micDrivePre > 1.001f)
                    band = std::tanh(micDrivePre * band) * micDriveComp;
                if (combFB > 0.001f && combD1 > 0.f) {
                    float y = band + combFB * readFrac(mComb1, mCombWrite, combD1);
                    mComb1[static_cast<size_t>(mCombWrite)] = y;
                    if (combD2 > 0.f) {
                        float y2 = y + combFB * readFrac(mComb2, mCombWrite, combD2);
                        mComb2[static_cast<size_t>(mCombWrite)] = y2;
                        y = y2;
                    }
                    band = y * 0.7f;   // series combs add energy; keep unity-ish
                }
                mCombWrite = (mCombWrite + 1) & kCombMask;
                x += p.micAmount * (band - x);
            } else {
                // Keep the comb write cursor moving so a mode flip reads a
                // freshly-zeroed span (reset() also clears on edges).
                mComb1[static_cast<size_t>(mCombWrite)] = 0.f;
                mComb2[static_cast<size_t>(mCombWrite)] = 0.f;
                mCombWrite = (mCombWrite + 1) & kCombMask;
            }

            // 4. CRUSH — buffered per sample would defeat the BLEP state, so
            // crush is applied below on the whole chunk (see after the loop).

            // 5. NOISE — generated on the medium, ducked under the voice;
            // TRANSMIT lifts it as the link fails.
            if (noiseOn) {
                float nz = 0.f;
                switch (p.noiseType) {
                    case 1: {   // CRACKLE — consonant-spark density
                        const float density = 3.f + 80.f * noiseBase
                                            + 4000.f * transient + 200.f * fail;
                        if (0.5f * (nextRand() + 1.f) < density / sr)
                            mCrackleEnergy = nextRand() * (0.25f + 0.75f * noiseGainFull);
                        mCrackleEnergy *= crackleDecay;
                        nz = mCrackleBP.process(mCrackleEnergy) * 2.5f;
                        break;
                    }
                    case 2: {   // HUM — 60 + 120 Hz
                        mHumPhase1 += humInc1; if (mHumPhase1 >= 1.f) mHumPhase1 -= 1.f;
                        mHumPhase2 += humInc2; if (mHumPhase2 >= 1.f) mHumPhase2 -= 1.f;
                        nz = noiseGainFull * (synth_lut::SineLookup(mHumPhase1)
                                              + 0.5f * synth_lut::SineLookup(mHumPhase2));
                        break;
                    }
                    default: {  // HISS — one-pole LP'd white
                        mHissLPState += hissLP * (nextRand() - mHissLPState);
                        nz = noiseGainFull * mHissLPState * 2.f;
                        break;
                    }
                }
                // Duck under the voice; the failing link overrides the duck.
                const float duck = std::min(1.f, mEnv / kDuckThresh);
                const float duckEff = duck + fail * (1.f - duck);
                x += nz * duckEff;
            }

            // 6. DROPOUT gain (LFO stutter and/or TRANSMIT dips), smoothed.
            float dropTarget = dropTargetLfo;
            if (mDropHold > 0) { --mDropHold; dropTarget = std::min(dropTarget, 0.15f); }
            mDropGain += dropCoef * (dropTarget - mDropGain);
            x *= mDropGain;

            mWet[static_cast<size_t>(i)] = x;
        }

        // CRUSH on the wet chunk (in place; BitCrusher keeps its own BLEP/S&H
        // state across chunks), then the section mix crossfade against dry.
        if (crushOn) {
            mCrusher.process(mWet.data(), m, crushMix, crushBits, crushSR);
            if (crushTrim < 0.999f)
                for (int i = 0; i < m; ++i) mWet[static_cast<size_t>(i)] *= crushTrim;
        }
        if (mix >= 0.999f) {
            for (int i = 0; i < m; ++i) buf[i] = mWet[static_cast<size_t>(i)];
        } else {
            for (int i = 0; i < m; ++i)
                buf[i] += mix * (mWet[static_cast<size_t>(i)] - buf[i]);
        }
    }

    // ── State ─────────────────────────────────────────────────────────────────
    double   mSampleRate = 48000.0;
    uint32_t mRng        = 0x9E3779B9u;

    std::array<float, kWarbleSize> mWarbleRing {};
    std::array<float, kCombSize>   mComb1 {};
    std::array<float, kCombSize>   mComb2 {};
    std::array<float, kChunk>      mWet {};
    int mWarbleWrite = 0;
    int mCombWrite   = 0;

    float mWowPhase = 0.f, mFlutterPhase = 0.f;

    float mCarrierPhase   = 0.f;
    float mCarrierHzState = 0.f;
    float mHeldF0         = 130.f;
    float mVoicedRamp     = 0.f;
    float mCombD1State = 0.f, mCombD2State = 0.f;

    float mEnv = 0.f, mEnvSlow = 0.f;
    float mFail = 0.f;
    float mDropGain = 1.f;
    int   mDropHold = 0;

    float mCrackleEnergy = 0.f;
    float mHissLPState   = 0.f;
    float mHumPhase1 = 0.f, mHumPhase2 = 0.f;
    bool  mCrushWasOn = false;

    SVFilter mHP, mLP, mPeak, mCrackleBP;
    BitCrusher mCrusher;
};
