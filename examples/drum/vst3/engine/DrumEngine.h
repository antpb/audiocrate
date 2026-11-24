//
//  DrumEngine.h — C++ port of the homecrate drum AUv3's Swift sampler engine.
//
//  The AUv3 split the work between a tiny C++ kernel (per-pad bitcrush/LPF +
//  master filter/IR — homecrate_drumDSPKernel) and the Swift AudioUnit (pad
//  playback, pitch, pan, sample edit, SOLA time-stretch, character/humanize,
//  hihat choke, silence tail). This class ports the Swift half faithfully:
//  same trigger math, same humanize constants, same render order.
//
//  Deliberate deviations from the AUv3:
//    - Host beat/tempo come from the VST3 ProcessContext (set per block via
//      setMusicalContext) instead of polling the AU musicalContextBlock.
//    - The metronome click and sample-record capture are omitted — they are
//      recorder-app integration features (the DAW provides both).
//    - Sample loading is WAV (16/24/32-bit PCM + float) instead of
//      AVAudioFile's any-format decoding.
//
//  Threading: render() runs on the audio thread and try-locks mBufLock; the
//  loader thread swaps pad buffers under the same lock (windows are only the
//  pointer swap — sample decode/stretch happen outside it).
//

#pragma once

#include "../dsp/homecrate_drumDSPKernel.h"
#include "WavFile.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

class DrumEngine {
public:
    static constexpr int kNumPads = 16;
    // Pad index = MIDI note − 36 (TR-style layout): pad 8 = HH PED closes pad 10 = HH OP.
    static constexpr int kHHPedalPad = 8;
    static constexpr int kHHOpenPad  = 10;
    static constexpr float kCharacterMaxDeviation = 0.4f;
    // Global humanize tuning (HomecrateDrumHumanize in the iOS tree).
    static constexpr float  kMaxVelSpan       = 0.15f;
    static constexpr double kMaxSwingFraction = 0.6;
    static constexpr double kMaxJitterMs      = 18.0;
    static constexpr int kSilenceTailFrames = 8192;

    struct PadSample {
        std::vector<float> left, right;   // session-rate stereo
        int frames() const { return static_cast<int>(left.size()); }
    };

    // ── lifecycle ───────────────────────────────────────────────────────────

    void initialize(double sampleRate, uint32_t maxFrames) {
        mSampleRate = sampleRate;
        mKernel.initialize(sampleRate, maxFrames);
        mScratchL.assign(maxFrames, 0.f);
        mScratchR.assign(maxFrames, 0.f);
        // Re-push every cached param into the kernel (filter coefficients are
        // sample-rate dependent).
        for (uint64_t a = 32; a <= 100; ++a) mKernel.setParameter(a, getParameter(a));
        for (int i = 0; i < kNumPads; ++i) mPlayheads[i] = -1.0;
        mSilentFrames = 1000000;
    }

    void deInitialize() {
        for (int i = 0; i < kNumPads; ++i) mPlayheads[i] = -1.0;
        for (auto& a : mPendingActive) a = false;
        mKernel.deInitialize();
    }

    homecrate_drumDSPKernel& kernel() { return mKernel; }
    double sampleRate() const { return mSampleRate; }

    // ── parameters (VST3 processor pushes plain values) ─────────────────────

    void setParameter(uint64_t a, float v) {
        const int i = static_cast<int>(a);
        if      (i <= 15)               mPadVolumes[i] = v;
        else if (i <= 31)               mPadPitches[i - 16] = v;
        else if (i >= 101 && i <= 116)  mPadStretchOn[i - 101] = v;
        else if (i >= 117 && i <= 132) {
            const int p = i - 117;
            if (std::fabs(mPadStretchAmt[p] - v) > 0.001f) mStretchDirty[p].store(true);
            mPadStretchAmt[p] = v;
        }
        else if (i >= 136 && i <= 151)  mPadCharacters[i - 136] = v;
        else if (i >= 152 && i <= 167)  mPadPans[i - 152] = v;
        else if (i >= 168 && i <= 183)  mPadSampleStart[i - 168] = v;
        else if (i >= 184 && i <= 199)  mPadSampleStop[i - 184] = v;
        else if (i >= 200 && i <= 215)  mPadFadeInMs[i - 200] = v;
        else if (i >= 216 && i <= 231)  mPadFadeOutMs[i - 216] = v;
        else if (i == 232)              mMasterHumanize = v;
        else if (i >= 233 && i <= 248)  mPadHumanizeExempt[i - 233] = v;
        // Kernel-side DSP params (per-pad 026S group + master bus).
        if (a >= 32 && a <= 100) {
            mKernelCache[a - 32] = v;
            mKernel.setParameter(a, v);
        }
    }

    float getParameter(uint64_t a) const {
        const int i = static_cast<int>(a);
        if      (i <= 15)               return mPadVolumes[i];
        else if (i <= 31)               return mPadPitches[i - 16];
        else if (i >= 32 && i <= 100)   return mKernelCache[i - 32];
        else if (i >= 101 && i <= 116)  return mPadStretchOn[i - 101];
        else if (i >= 117 && i <= 132)  return mPadStretchAmt[i - 117];
        else if (i >= 136 && i <= 151)  return mPadCharacters[i - 136];
        else if (i >= 152 && i <= 167)  return mPadPans[i - 152];
        else if (i >= 168 && i <= 183)  return mPadSampleStart[i - 168];
        else if (i >= 184 && i <= 199)  return mPadSampleStop[i - 184];
        else if (i >= 200 && i <= 215)  return mPadFadeInMs[i - 200];
        else if (i >= 216 && i <= 231)  return mPadFadeOutMs[i - 216];
        else if (i == 232)              return mMasterHumanize;
        else if (i >= 233 && i <= 248)  return mPadHumanizeExempt[i - 233];
        return 0.f;
    }

    bool stretchDirty(int pad) { return mStretchDirty[pad].exchange(false); }

    // ── musical context (per block from ProcessContext) ─────────────────────

    void setMusicalContext(bool valid, double beat, double tempo) {
        mBeatValid = valid;
        mBeat = beat;
        mTempo = tempo > 0 ? tempo : 120.0;
    }

    // ── triggers (audio thread) ─────────────────────────────────────────────

    // Host MIDI note-on: note → pad, character + humanize velocity, swing/jitter
    // deferral through the pending queue. Mirrors the AUv3 render-event walk.
    void noteOn(int note, float velocity01) {
        const int pad = std::clamp(note - 36, 0, kNumPads - 1);
        const float vel = applyCharacter(velocity01, pad);

        int delayFrames = 0;
        if (mMasterHumanize > 0.001f && mPadHumanizeExempt[pad] < 0.5f) {
            const double jitterMs = double(mMasterHumanize) * kMaxJitterMs * double(nextRandUnit());
            delayFrames = static_cast<int>(jitterMs * 0.001 * mSampleRate);
            if (mBeatValid) {
                const long nearest16th = std::lround(mBeat * 4.0);
                if (nearest16th % 2 != 0) {
                    const double framesPer16th = mSampleRate * 60.0 / mTempo / 4.0;
                    delayFrames += static_cast<int>(double(mMasterHumanize) * kMaxSwingFraction * framesPer16th);
                }
            }
        }
        if (delayFrames > 0) enqueuePendingTrigger(pad, vel, delayFrames);
        else                 firePad(pad, vel);
    }

    // Editor audition path (same as the AUv3's triggerPad — character applies).
    void audition(int pad, float velocity01) {
        if (pad < 0 || pad >= kNumPads) return;
        firePad(pad, applyCharacter(std::clamp(velocity01, 0.f, 1.f), pad));
    }

    // ── render (audio thread) ───────────────────────────────────────────────

    // Returns true when the block was hard-muted (host may set silence flags).
    bool render(float* outL, float* outR, int frames) {
        if (frames <= 0) return true;

        drainPendingTriggers(frames);

        if (!mBufLock.try_lock()) {
            std::memset(outL, 0, sizeof(float) * frames);
            std::memset(outR, 0, sizeof(float) * frames);
            return true;
        }

        // Active-source check + silence tail (IR tail ≈ 1k samples; 8192 margin).
        bool anyActive = false;
        for (int i = 0; i < kNumPads; ++i)
            if (mPlayheads[i] >= 0.0) { anyActive = true; break; }
        if (!anyActive && hasPendingTriggers()) anyActive = true;

        if (anyActive) mSilentFrames = 0;
        else           mSilentFrames += frames;

        if (mSilentFrames > kSilenceTailFrames) {
            std::memset(outL, 0, sizeof(float) * frames);
            std::memset(outR, 0, sizeof(float) * frames);
            mBufLock.unlock();
            return true;
        }

        std::memset(outL, 0, sizeof(float) * frames);
        std::memset(outR, 0, sizeof(float) * frames);

        const bool scratchOK = static_cast<int>(mScratchL.size()) >= frames;

        for (int pad = 0; pad < kNumPads; ++pad) {
            double pos = mPlayheads[pad];
            const bool stretchOn = mPadStretchOn[pad] >= 0.5f;
            const PadSample* buf = stretchOn
                ? (mPadStretched[pad] ? mPadStretched[pad] : mPadBuffers[pad])
                : mPadBuffers[pad];
            if (pos < 0.0 || !buf) continue;

            const int bufLen = buf->frames();
            const double bufLenD = double(bufLen);
            if (bufLen <= 1 || pos >= bufLenD) { mPlayheads[pad] = -1.0; continue; }

            const float vol = mPadVolumes[pad] * mPadVelocities[pad];
            const float p = std::clamp(mPadPans[pad], -1.f, 1.f);
            const float panAng = (p + 1.f) * (float(M_PI) / 4.f);
            const float gainL = vol * std::cos(panAng);
            const float gainR = vol * std::sin(panAng);
            const float* srcL = buf->left.data();
            const float* srcR = buf->right.data();
            const double rate = std::pow(2.0, double(mPadPitches[pad]) / 12.0);

            // Non-destructive sample edit (start / stop / fades).
            const double startF = double(std::clamp(mPadSampleStart[pad], 0.f, 1.f)) * bufLenD;
            double stopF = double(std::clamp(mPadSampleStop[pad], 0.f, 1.f)) * bufLenD;
            stopF = std::min(bufLenD, std::max(startF + 1.0, stopF));
            const double endPos = std::min(bufLenD - 1.0, stopF);
            const double voiceLen = stopF - startF;
            const double fadeInFr  = std::min(double(mPadFadeInMs[pad])  * 0.001 * mSampleRate, voiceLen);
            const double fadeOutFr = std::min(double(mPadFadeOutMs[pad]) * 0.001 * mSampleRate, voiceLen);
            const double invFadeIn  = fadeInFr  > 0.0 ? 1.0 / fadeInFr  : 0.0;
            const double invFadeOut = fadeOutFr > 0.0 ? 1.0 / fadeOutFr : 0.0;
            const bool hasFade = invFadeIn > 0.0 || invFadeOut > 0.0;

            if (scratchOK) {
                float* sL = mScratchL.data();
                float* sR = mScratchR.data();
                int rendered = 0;
                for (int f = 0; f < frames; ++f) {
                    if (pos >= endPos) break;
                    const int idx = static_cast<int>(pos);
                    const float frac = static_cast<float>(pos - idx);
                    float l = srcL[idx] * (1.f - frac) + srcL[idx + 1] * frac;
                    float r = srcR[idx] * (1.f - frac) + srcR[idx + 1] * frac;
                    if (hasFade) {
                        float g = 1.f;
                        if (invFadeIn  > 0.0) { const double rel = pos - startF; if (rel < fadeInFr)  g *= float(rel * invFadeIn); }
                        if (invFadeOut > 0.0) { const double rem = stopF - pos;  if (rem < fadeOutFr) g *= float(std::max(0.0, rem) * invFadeOut); }
                        l *= g; r *= g;
                    }
                    sL[f] = l;
                    sR[f] = r;
                    pos += rate;
                    rendered = f + 1;
                }
                if (rendered < frames) {
                    std::memset(sL + rendered, 0, sizeof(float) * (frames - rendered));
                    std::memset(sR + rendered, 0, sizeof(float) * (frames - rendered));
                }

                // Per-pad 026S DSP (bitcrush + filter). No-op if bypassed.
                mKernel.processPadInPlace(pad, sL, sR, rendered);

                for (int f = 0; f < rendered; ++f) {
                    outL[f] += sL[f] * gainL;
                    outR[f] += sR[f] * gainR;
                }
            } else {
                for (int f = 0; f < frames; ++f) {
                    if (pos >= endPos) break;
                    const int idx = static_cast<int>(pos);
                    const float frac = static_cast<float>(pos - idx);
                    float l = srcL[idx] * (1.f - frac) + srcL[idx + 1] * frac;
                    float r = srcR[idx] * (1.f - frac) + srcR[idx + 1] * frac;
                    if (hasFade) {
                        float g = 1.f;
                        if (invFadeIn  > 0.0) { const double rel = pos - startF; if (rel < fadeInFr)  g *= float(rel * invFadeIn); }
                        if (invFadeOut > 0.0) { const double rem = stopF - pos;  if (rem < fadeOutFr) g *= float(std::max(0.0, rem) * invFadeOut); }
                        l *= g; r *= g;
                    }
                    outL[f] += l * gainL;
                    outR[f] += r * gainR;
                    pos += rate;
                }
            }

            mPlayheads[pad] = pos >= endPos ? -1.0 : pos;
        }

        // Master bus DSP — filter + IR (state stays coherent across blocks).
        mKernel.processMasterBus(outL, outR, frames, anyActive);

        mBufLock.unlock();
        return false;
    }

    // ── sample loading (loader thread) ──────────────────────────────────────

    // Install a decoded, session-rate stereo sample into a pad slot.
    void installPadSample(int pad, std::vector<float>&& left, std::vector<float>&& right) {
        if (pad < 0 || pad >= kNumPads) return;
        auto* fresh = new PadSample{std::move(left), std::move(right)};
        PadSample* dropA = nullptr;
        PadSample* dropB = nullptr;
        mBufLock.lock();
        mPlayheads[pad] = -1.0;
        dropA = mPadBuffers[pad];
        mPadBuffers[pad] = fresh;
        dropB = mPadStretched[pad];
        mPadStretched[pad] = nullptr;   // recompute below installs a fresh one
        mBufLock.unlock();
        delete dropA;
        delete dropB;
        recomputeStretch(pad);
    }

    void clearPad(int pad) {
        if (pad < 0 || pad >= kNumPads) return;
        PadSample* dropA = nullptr;
        PadSample* dropB = nullptr;
        mBufLock.lock();
        mPlayheads[pad] = -1.0;
        dropA = mPadBuffers[pad];   mPadBuffers[pad] = nullptr;
        dropB = mPadStretched[pad]; mPadStretched[pad] = nullptr;
        mBufLock.unlock();
        delete dropA;
        delete dropB;
    }

    bool padLoaded(int pad) const {
        return pad >= 0 && pad < kNumPads && mPadBuffers[pad] != nullptr;
    }

    // S950-style SOLA stretch (port of TimeStretch.swift). Loader thread only.
    void recomputeStretch(int pad) {
        if (pad < 0 || pad >= kNumPads) return;
        const PadSample* src = mPadBuffers[pad];   // loader thread owns swaps — safe read
        if (!src || src->frames() == 0) return;
        const float ratio = mPadStretchAmt[pad];
        PadSample* stretched = timeStretchSOLA(*src, ratio, mSampleRate);
        PadSample* drop = nullptr;
        mBufLock.lock();
        drop = mPadStretched[pad];
        mPadStretched[pad] = stretched;
        // A playing voice may sit past the new buffer's end; render's bounds
        // check handles it (voice just ends).
        mBufLock.unlock();
        delete drop;
    }

    ~DrumEngine() {
        for (int i = 0; i < kNumPads; ++i) {
            delete mPadBuffers[i];
            delete mPadStretched[i];
        }
    }

private:
    // ── humanize / character (audio thread) ─────────────────────────────────

    float nextRandUnit() {
        mRng ^= mRng << 13; mRng ^= mRng >> 17; mRng ^= mRng << 5;
        return static_cast<float>(mRng) / static_cast<float>(0xFFFFFFFFu);
    }

    // Per-pad Character (directional triangular spread) + global Humanize
    // velocity breathe. Identical math to the AUv3's applyCharacter.
    float applyCharacter(float velScale, int pad) {
        float v = velScale;
        const float chr = mPadCharacters[pad];
        if (std::fabs(chr) > 0.001f) {
            const float tri = (nextRandUnit() + nextRandUnit()) * 0.5f;
            const float dir = chr < 0 ? -1.f : 1.f;
            v += dir * std::fabs(chr) * kCharacterMaxDeviation * tri;
        }
        const float hz = mMasterHumanize;
        if (hz > 0.001f && mPadHumanizeExempt[pad] < 0.5f) {
            const float bip = ((nextRandUnit() + nextRandUnit()) * 0.5f - 0.5f) * 2.f;
            v += bip * hz * kMaxVelSpan;
        }
        return std::clamp(v, 0.02f, 1.0f);
    }

    // Start frame honoring the per-pad START point on the ACTIVE buffer.
    double voiceStartFrame(int pad) {
        const bool stretchOn = mPadStretchOn[pad] >= 0.5f;
        const PadSample* buf = stretchOn
            ? (mPadStretched[pad] ? mPadStretched[pad] : mPadBuffers[pad])
            : mPadBuffers[pad];
        if (!buf) return 0.0;
        const double len = buf->frames();
        const double start = double(std::clamp(mPadSampleStart[pad], 0.f, 1.f));
        return std::min(std::floor(start * len), std::max(0.0, len - 1.0));
    }

    void firePad(int pad, float velocity) {
        // No empty-pad guard — matches the AUv3's MIDI path: an unloaded pad
        // renders nothing (render checks the buffer), but HH PED must still
        // choke a ringing HH OP even with no pedal sample loaded.
        mPadVelocities[pad] = velocity;
        mPlayheads[pad] = mPadBuffers[pad] ? voiceStartFrame(pad) : -1.0;
        // Hihat choke: HH PED instantly silences a ringing HH OP.
        if (pad == kHHPedalPad) mPlayheads[kHHOpenPad] = -1.0;
    }

    void enqueuePendingTrigger(int pad, float vel, int frames) {
        for (size_t i = 0; i < mPendingActive.size(); ++i) {
            if (!mPendingActive[i]) {
                mPendingActive[i] = true;
                mPendingPad[i] = pad;
                mPendingVel[i] = vel;
                mPendingFrames[i] = frames;
                return;
            }
        }
        firePad(pad, vel);
    }

    void drainPendingTriggers(int frames) {
        for (size_t i = 0; i < mPendingActive.size(); ++i) {
            if (!mPendingActive[i]) continue;
            mPendingFrames[i] -= frames;
            if (mPendingFrames[i] <= 0) {
                mPendingActive[i] = false;
                firePad(mPendingPad[i], mPendingVel[i]);
            }
        }
    }

    bool hasPendingTriggers() const {
        for (bool a : mPendingActive) if (a) return true;
        return false;
    }

    // ── SOLA time stretch (port of TimeStretch.swift, same constants) ───────

    static PadSample* timeStretchSOLA(const PadSample& input, float ratio, double sr = 0) {
        if (!(ratio > 0.05f) || !std::isfinite(ratio)) return nullptr;
        const int inFrames = input.frames();
        if (inFrames <= 0) return nullptr;

        if (std::fabs(ratio - 1.0f) < 0.001f)
            return new PadSample(input);   // identity copy

        // sr only affects the splice length; the engine stores samples at the
        // session rate, so use it when provided (0 → 48k default splice).
        const double rate = sr > 0 ? sr : 48000.0;
        const int frameSize = std::max(64, static_cast<int>(std::lround(rate * 0.030)));
        const int hopOut = frameSize / 2;
        const int hopIn  = std::max(1, static_cast<int>(std::lround(double(hopOut) * double(ratio))));
        const int outFrames = std::max(1, static_cast<int>(std::lround(double(inFrames) / double(ratio))));

        auto* out = new PadSample();
        out->left.assign(outFrames + frameSize, 0.f);
        out->right.assign(outFrames + frameSize, 0.f);

        std::vector<float> window(frameSize);
        const float denom = float(frameSize - 1);
        for (int i = 0; i < frameSize; ++i)
            window[i] = 0.5f - 0.5f * std::cos(2.f * float(M_PI) * float(i) / denom);

        int outPos = 0, inPos = 0;
        while (outPos < outFrames) {
            if (inPos < inFrames) {
                const int safeEnd = std::min(inPos + frameSize, inFrames);
                int k = 0;
                for (int i = inPos; i < safeEnd; ++i, ++k) {
                    out->left[outPos + k]  += input.left[i]  * window[k];
                    out->right[outPos + k] += input.right[i] * window[k];
                }
            }
            outPos += hopOut;
            inPos  += hopIn;
        }
        out->left.resize(outFrames);
        out->right.resize(outFrames);
        return out;
    }

    struct EngineSpinLock {
        std::atomic_flag flag = ATOMIC_FLAG_INIT;
        bool try_lock() { return !flag.test_and_set(std::memory_order_acquire); }
        void lock()     { while (flag.test_and_set(std::memory_order_acquire)) {} }
        void unlock()   { flag.clear(std::memory_order_release); }
    };

    homecrate_drumDSPKernel mKernel;
    double mSampleRate = 48000.0;

    // Cached params
    float mPadVolumes[kNumPads]        = {1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1};
    float mPadPitches[kNumPads]        = {};
    float mPadStretchOn[kNumPads]      = {};
    float mPadStretchAmt[kNumPads]     = {1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1};
    float mPadCharacters[kNumPads]     = {};
    float mPadPans[kNumPads]           = {};
    float mPadSampleStart[kNumPads]    = {};
    float mPadSampleStop[kNumPads]     = {1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1};
    float mPadFadeInMs[kNumPads]       = {};
    float mPadFadeOutMs[kNumPads]      = {};
    float mPadHumanizeExempt[kNumPads] = {};
    float mMasterHumanize = 0.f;
    // Kernel params 32..100 mirrored for getParameter/initialize re-push.
    float mKernelCache[69] = {
        // 32..47 sRate=1
        1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
        // 48..63 bits=16
        16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
        // 64..79 cut=20000
        20000,20000,20000,20000,20000,20000,20000,20000,
        20000,20000,20000,20000,20000,20000,20000,20000,
        // 80..95 res=0
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        // 96 masterCut, 97 masterRes, 98 irMix, 99 bypass, 100 masterVol
        20000, 0, 0, 0, 1,
    };

    std::atomic<bool> mStretchDirty[kNumPads] = {};

    // Playback state (audio thread)
    double mPlayheads[kNumPads]  = {-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1};
    float mPadVelocities[kNumPads] = {1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1};

    PadSample* mPadBuffers[kNumPads]   = {};
    PadSample* mPadStretched[kNumPads] = {};
    EngineSpinLock mBufLock;

    std::array<bool, 64>  mPendingActive = {};
    std::array<int, 64>   mPendingPad = {};
    std::array<float, 64> mPendingVel = {};
    std::array<int, 64>   mPendingFrames = {};

    uint32_t mRng = 0x9E3779B9u;
    int mSilentFrames = 1000000;

    bool mBeatValid = false;
    double mBeat = 0.0;
    double mTempo = 120.0;

    std::vector<float> mScratchL, mScratchR;
};
