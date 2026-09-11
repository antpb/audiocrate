//
//  GrainEngine.h
//  homecrate grain
//
//  Granular capture + playback engine. Header-only (LofiEngine convention):
//  included ONLY by homecrate_grainDSPKernel.mm, forward-declared everywhere
//  else, so it never reaches the Swift bridging header.
//
//  One STEREO capture ring pair (shared cursor) serves two modes:
//
//    LIVE  — the ring rolls forever; grains are drawn from a trailing window
//            behind the write head. FREEZE halts writes so the trailing
//            window becomes an infinite hold.
//    CATCH — Bad-Mood-style micro-looper: the ring rolls until a catch
//            toggle latches the most recent loopLength as a loop REGION of
//            the same ring (zero memcpy). Grains are drawn around a virtual
//            playhead that scans the region at scan × clockRatio. Overdub
//            writes back into the region through a per-pass fade (loop
//            stacking / looper-as-delay).
//
//  RT contract (suite rules): all allocation in init(); fixed voice array;
//  xorshift32 randomness only (never rand()); every ring/LUT access goes
//  through clamped index helpers — OS 26's hardened libc++ aborts the whole
//  extension on a single vector[] overrun, so a racing read must degrade to a
//  wrong sample, never abort (AmpDelayEngine::readFrac precedent). srcPos is
//  double and write positions are int64 — float mantissa exhausts within
//  minutes of absolute sample positions.
//

#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

class GrainEngine {
public:
    static constexpr int kMaxGrains     = 48;
    static constexpr int kWindowSize    = 1024;   // + guard sample
    static constexpr int kNumWindows    = 4;      // Hann, Triangle, Decay, Swell
    static constexpr double kRingSeconds = 8.0;
    static constexpr int kWaveformBuckets = 128;

    // Per-block parameter snapshot, composed by the kernel from its mirrors.
    // All spawn-relevant values are re-snapshotted INTO each grain at spawn
    // time, so mid-life automation never modulates a sounding grain.
    struct Params {
        int   captureMode  = 0;      // 0 Live, 1 Catch
        bool  freezeHold   = false;  // latching hold (halts ring writes)
        bool  overdub      = false;  // write into the latched region
        float loopFade     = 0.f;    // 0 = infinite stack, 1 ≈ −6 dB per pass
        float sizeMs       = 120.f;
        float densityHz    = 18.f;
        float spray        = 0.25f;
        float pitchSemis   = 0.f;
        bool  pitchQuant   = false;  // snap to {0, ±7, ±12, ±24}
        float pitchRand    = 0.f;    // 0–1 → uniform ±12 st before quantize
        float reverseProb  = 0.f;
        float spread       = 0.6f;   // stereo pan scatter
        int   shape        = 0;      // window index
        float scan         = 1.f;    // frozen-playhead speed, −2…+2
        float clockRatio   = 1.f;    // global CLOCK multiplier
        bool  zeroOrderHold = false; // CLOCK degrade: ZOH ring reads
        // ROOT MIDI-mode transpose, folded into the total before the key snap.
        float pitchOffsetSemis = 0.f;
        // Global key (chassis keybed): pitchQuant snaps the TOTAL grain pitch
        // so keyRoot+total lands on an enabled pitch class — texture, random
        // and MIDI offsets all end up in key together.
        int   keyMask = 0x0FFF;
        float keyRoot = 60.f;
        // PLAY MIDI mode: while active, grains spawn ONLY when notes are
        // held; each grain picks a held note (round-robin via rng) whose
        // offset transposes it post-quantize and whose velocity scales it.
        bool  midiPlay  = false;
        int   noteCount = 0;
        float noteSemis[10] = {};
        float noteVel[10]   = {};
        // Per-note attack/release envelope (kernel-computed, block-rate) —
        // scales the spawned grain's gain so released notes RING OUT at
        // decaying level instead of hard-gating.
        float noteEnv[10]   = { 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 };
        // Perf flags (kernel-computed per block):
        // needMono: something consumes the grain-mono feedback tap — skip the
        // fill + per-sample accumulation otherwise.
        // cleanWrite: no feedback path can make the ring hot (no delay→ring
        // route, no grain regen) — a clamp replaces the per-sample tanh.
        bool  needMono   = false;
        bool  cleanWrite = true;
    };

    struct Grain {
        bool     active     = false;
        double   srcPos     = 0.0;   // fractional absolute ring position
        double   srcInc     = 1.0;   // pitchRatio × clockRatio; negative = reversed
        uint32_t age        = 0;
        uint32_t dur        = 1;
        float    winPhase   = 0.f;   // 0…kWindowSize
        float    winInc     = 0.f;
        int      winIdx     = 0;
        float    ampL       = 0.f;
        float    ampR       = 0.f;
        float    pan        = 0.f;   // display only
        float    pitchSemis = 0.f;   // display only
        float    env        = 0.f;   // last window value (steal-quietest + display)
    };

    void init(double sampleRate, int maxFrames) {
        mSampleRate = sampleRate;
        mRingSize   = static_cast<int64_t>(kRingSeconds * sampleRate);
        // STEREO capture (two rings, one shared cursor): mono-summing the
        // input combed against the amp's independent per-channel NAM models.
        // A mono source simply writes identical channels.
        mRingL.assign(static_cast<size_t>(mRingSize), 0.f);
        mRingR.assign(static_cast<size_t>(mRingSize), 0.f);
        mGrainMono.assign(static_cast<size_t>(std::max(maxFrames, 64)), 0.f);

        // Window LUTs (+1 guard sample so a clamped read at kWindowSize is safe).
        for (int w = 0; w < kNumWindows; ++w) {
            for (int i = 0; i <= kWindowSize; ++i) {
                const float x = static_cast<float>(i) / static_cast<float>(kWindowSize);
                float v = 0.f;
                switch (w) {
                    case 1:  v = 1.f - std::abs(2.f * x - 1.f); break;               // Triangle
                    case 2:  v = std::min(1.f, x * 16.f) * std::exp(-4.f * x); break; // Decay
                    case 3:  v = std::min(1.f, (1.f - x) * 16.f)
                               * std::exp(-4.f * (1.f - x)); break;                   // Swell
                    default: v = 0.5f * (1.f - std::cos(2.f * static_cast<float>(M_PI) * x)); // Hann
                }
                mWindows[static_cast<size_t>(w)][static_cast<size_t>(i)] = v;
            }
        }

        reset();
    }

    void reset() {
        std::fill(mRingL.begin(), mRingL.end(), 0.f);
        std::fill(mRingR.begin(), mRingR.end(), 0.f);
        std::fill(mGrainMono.begin(), mGrainMono.end(), 0.f);
        for (auto& g : mVoices) g = Grain{};
        mWriteAbs     = 0;
        mLatched      = false;
        mLoopPinned   = false;
        mLoopStartAbs = 0;
        mLoopLen      = 1;
        mPlayheadAbs  = 0.0;
        mWriteRamp    = 1.f;
        mCountdown    = 0.0;
        mCatchPending.store(false, std::memory_order_relaxed);
        mWasFrozen    = false;
    }

    // Catch toggle request — set from the parameter/CC edge (any thread),
    // consumed at the top of the next writeRing() on the render thread.
    void requestCatchToggle() { mCatchPending.store(true, std::memory_order_release); }

    // Deactivate all voices. Called by the kernel when NOTHING consumes the
    // grain bus (mix, sends and regen all off) so renderGrains can be skipped
    // entirely; grains hold no feedback energy, so resuming just spawns fresh.
    void sleep() {
        for (auto& g : mVoices) { g.active = false; g.env = 0.f; }
    }

    // ── Loaded/persisted loops (file-backed captures) ─────────────────────────
    // A PINNED loop is one loaded from a file: the latch cannot be released
    // by the catch toggle or a mode flip, so the sample can't be silently
    // destroyed. Overdub still writes the RING (dynamic looper over grains);
    // the disk file stays pristine and reload restores it.

    // Caller (kernel) holds the kernel lock — the render thread trylocks and
    // copy-throughs during the write, same contract as initialize().
    // Mono sources pass the same pointer for both channels.
    void loadLoop(const float* samplesL, const float* samplesR, int count) {
        if (!samplesL || count <= 0 || mRingSize <= 0) return;
        if (!samplesR) samplesR = samplesL;
        const int64_t len = std::min<int64_t>(count, mRingSize - 256);
        for (int64_t i = 0; i < len; ++i) {
            mRingL[static_cast<size_t>(i)] = std::clamp(samplesL[i], -1.5f, 1.5f);
            mRingR[static_cast<size_t>(i)] = std::clamp(samplesR[i], -1.5f, 1.5f);
        }
        mWriteAbs     = len;
        mLoopStartAbs = 0;
        mLoopLen      = std::max<int64_t>(len, 256);
        mPlayheadAbs  = 0.0;
        mLatched      = true;
        mLoopPinned   = true;
        mWriteRamp    = 0.f;   // frozen; seam ramp re-fades if ever released
        mWasFrozen    = true;
        mLoopGen     += 1;
    }

    void releaseLoop() {
        mLoopPinned = false;
        mLatched    = false;
    }

    bool loopPinned() const { return mLoopPinned; }

    // Monotonic change counter: bumps on catch, load and overdubbed blocks —
    // the AU compares it against its last save to know the loop is dirty.
    uint64_t loopGeneration() const { return mLoopGen; }

    // Wrap-aware copy of the latched loop for persistence. Caller (kernel)
    // holds the kernel lock. Returns frames copied (0 = nothing latched).
    int copyLoop(float* dstL, float* dstR, int maxCount) const {
        if (!mLatched || mLoopLen <= 0 || !dstL || !dstR) return 0;
        const int n = static_cast<int>(std::min<int64_t>(mLoopLen, maxCount));
        for (int i = 0; i < n; ++i) {
            const size_t idx = ringIndex(mLoopStartAbs + i);
            dstL[i] = mRingL[idx];
            dstR[i] = mRingR[idx];
        }
        return n;
    }

    bool  latched()  const { return mLatched; }
    // Frozen = writes halted (either an explicit hold or a latched loop).
    bool  frozen(const Params& p) const { return p.freezeHold || mLatched; }

    // ── Grain rendering (call BEFORE this block's writeRing) ──────────────────
    // ADDS windowed grains into outL/outR (caller zeros them) and rewrites the
    // internal mono sum (grainMono) used for ring regeneration and the delay
    // send. Reads only ring state as of the previous block — the spawn safety
    // margin exceeds a block, so grains never race the write head.
    void renderGrains(float* outL, float* outR, int n, const Params& p) {
        float* monoOut = mGrainMono.data();
        const int monoCap = static_cast<int>(mGrainMono.size());
        const bool accMono = p.needMono && monoCap >= n;
        if (accMono) std::fill_n(monoOut, n, 0.f);

        // Scheduler: stochastic inter-onset countdown, sample-accurate offsets.
        const double interval = mSampleRate / std::max(1.0, static_cast<double>(p.densityHz));
        const float  jitter   = 0.75f * std::clamp(p.spray, 0.f, 1.f);
        int f = 0;
        while (f < n) {
            if (mCountdown <= 0.0) {
                // PLAY mode with no keys held = silence (the keys ARE the
                // gate); the countdown still reloads so timing stays honest.
                if (!p.midiPlay || p.noteCount > 0) spawnGrain(p);
                mCountdown += interval * (1.0 + jitter * (frand() - 0.5f) * 2.0);
                if (mCountdown < 1.0) mCountdown = 1.0;
            }
            const int step = std::min(n - f, static_cast<int>(std::ceil(mCountdown)));
            mCountdown -= step;
            f += step;
        }

        const float* win = mWindows[static_cast<size_t>(
            std::clamp(p.shape, 0, kNumWindows - 1))].data();

        // PERF: the ring read cursor is a WRAPPED double stepped with branch
        // wraps — the previous per-sample ringIndex() cost two int64 modulos
        // per grain-sample (both lerp taps), the top cost of this loop by far.
        // rel >= 0 always holds, so (int) truncation == floor and the frac
        // falls out without std::floor.
        const double ringSize = static_cast<double>(mRingSize);
        const int    size     = static_cast<int>(mRingSize);
        if (size <= 0) return;
        for (auto& g : mVoices) {
            if (!g.active) continue;
            double rel = std::fmod(g.srcPos, ringSize);
            if (rel < 0.0) rel += ringSize;
            int adv = 0;
            for (int i = 0; i < n; ++i) {
                if (g.age >= g.dur) { g.active = false; g.env = 0.f; break; }
                const int   wi = std::clamp(static_cast<int>(g.winPhase), 0, kWindowSize);
                const float w  = win[static_cast<size_t>(wi)];
                int i0 = static_cast<int>(rel);
                if (i0 >= size) i0 = size - 1;   // degrade, never abort (hardened libc++)
                // Stereo frame read: both channels at the shared cursor, so
                // the grain carries the source's stereo image; ampL/ampR are
                // BALANCE gains (unity at center), set at spawn.
                float sL, sR;
                if (p.zeroOrderHold) {
                    sL = mRingL[static_cast<size_t>(i0)];
                    sR = mRingR[static_cast<size_t>(i0)];
                } else {
                    const float frac = static_cast<float>(rel - static_cast<double>(i0));
                    const int   i1   = (i0 + 1 < size) ? i0 + 1 : 0;
                    sL = mRingL[static_cast<size_t>(i0)]
                       + frac * (mRingL[static_cast<size_t>(i1)] - mRingL[static_cast<size_t>(i0)]);
                    sR = mRingR[static_cast<size_t>(i0)]
                       + frac * (mRingR[static_cast<size_t>(i1)] - mRingR[static_cast<size_t>(i0)]);
                }
                const float wsL = sL * w * g.ampL;
                const float wsR = sR * w * g.ampR;
                outL[i] += wsL;
                outR[i] += wsR;
                if (accMono) monoOut[i] += 0.5f * (wsL + wsR);
                g.env = w;
                rel += g.srcInc;
                if (rel >= ringSize)  rel -= ringSize;
                else if (rel < 0.0)   rel += ringSize;
                g.winPhase += g.winInc;
                g.age      += 1;
                adv        += 1;
            }
            g.srcPos += g.srcInc * static_cast<double>(adv);
        }

        // Advance the frozen/latched playhead once per block (audible only
        // through grains, so block-rate advancement is exact enough and keeps
        // the per-sample loop lean).
        if (mLatched && mLoopLen > 1) {
            mPlayheadAbs += static_cast<double>(p.scan) * p.clockRatio * n;
            mPlayheadAbs = wrapToLoop(mPlayheadAbs);
        } else if (frozen(p)) {
            // Live-freeze: playhead scans the trailing window.
            mPlayheadAbs += static_cast<double>(p.scan) * p.clockRatio * n;
            const double span  = std::max(1.0, mFreezeSpan);
            const double start = static_cast<double>(mWriteAbs) - span;
            if (mPlayheadAbs >= static_cast<double>(mWriteAbs)) mPlayheadAbs -= span;
            if (mPlayheadAbs < start)                           mPlayheadAbs += span;
        }
    }

    const float* grainMono() const { return mGrainMono.data(); }

    // ── Ring write pass (call AFTER the delay, with the composed source) ──────
    // src = monoIn / monoIn+fx / fx, already composed and gain-staged by the
    // kernel. Every write is tanh-bounded: this is where all feedback paths
    // converge, so worst case is saturated self-oscillation, never blowup.
    // loopLenSamples: the catch span to latch if a toggle is pending (kernel
    // resolves free-running seconds vs. beat-sync per block).
    void writeRing(const float* srcL, const float* srcR, int n,
                   const Params& p, int64_t loopLenSamples) {
        // Consume a pending catch toggle at a block edge. A PINNED (file-
        // backed) loop ignores the toggle — release goes through releaseLoop()
        // (the eject button) so the sample can't be flushed by a stray tap.
        if (mCatchPending.exchange(false, std::memory_order_acq_rel)) {
            if (p.captureMode == 1 && !mLoopPinned) {
                if (mLatched) {
                    mLatched = false;                    // release → resume rolling
                } else {
                    mLoopLen      = std::clamp<int64_t>(loopLenSamples, 256, mRingSize - 256);
                    mLoopLen      = std::min(mLoopLen, mWriteAbs > 0 ? mWriteAbs : mLoopLen);
                    mLoopStartAbs = std::max<int64_t>(0, mWriteAbs - mLoopLen);
                    mPlayheadAbs  = static_cast<double>(mLoopStartAbs);
                    mLatched      = true;
                    mLoopGen     += 1;
                }
            }
        }
        if (p.captureMode == 0 && mLatched && !mLoopPinned)
            mLatched = false;   // mode flip releases (never a pinned loop)

        const bool isFrozen = frozen(p);
        if (isFrozen && !mWasFrozen) {
            // Entering a hold: remember the span the live-freeze playhead scans.
            mFreezeSpan  = static_cast<double>(std::min<int64_t>(mWriteAbs,
                              std::max<int64_t>(256, loopLenSamples)));
            if (!mLatched) mPlayheadAbs = static_cast<double>(mWriteAbs) - mFreezeSpan;
        }
        mWasFrozen = isFrozen;

        // 8 ms equal-power write ramp at freeze edges (looper seam precedent):
        // ramp → 0 preserves old ring content smoothly, ramp → 1 resumes.
        const float rampCoef = 1.f - std::exp(-1.f / (0.008f * static_cast<float>(mSampleRate)));
        const float rampTarget = isFrozen ? 0.f : 1.f;

        // PERF: the state branches (overdub / live / frozen) are constant for
        // the whole block — hoisted out of the sample loop. The live path
        // steps a local ring index (ONE ringIndex() modulo per block, not one
        // per sample), and tanh-bounds the write only when a feedback route
        // can actually make the ring hot (cleanWrite: a ±1.5 clamp matches
        // the output clamp and costs two ops instead of a transcendental).
        if (mLatched && p.overdub && mLoopLen > 1) {
            // Overdub fade: full-pass attenuation spread per-sample so one
            // loop cycle lands exactly on it. loopFade 1 ≈ −6 dB/pass.
            // Always tanh-bounded — stacking is a feedback path by nature.
            const float passGain = 1.f - 0.5f * std::clamp(p.loopFade, 0.f, 1.f);
            const float fadeCoeff = std::pow(std::max(passGain, 1e-3f),
                                             1.f / static_cast<float>(mLoopLen));
            for (int i = 0; i < n; ++i) {
                mWriteRamp += rampCoef * (rampTarget - mWriteRamp);
                const double lp  = wrapToLoop(mPlayheadAbs + i);
                const size_t idx = ringIndex(static_cast<int64_t>(lp));
                mRingL[idx] = std::tanh(mRingL[idx] * fadeCoeff + std::tanh(srcL[i]) + 1e-20f);
                mRingR[idx] = std::tanh(mRingR[idx] * fadeCoeff + std::tanh(srcR[i]) + 1e-20f);
            }
            mLoopGen += 1;   // overdub dirtied the loop (RING only — a pinned
                             // loop's disk file stays pristine; reload restores)
        } else if (!isFrozen) {
            const size_t sz = mRingL.size();
            size_t idx = ringIndex(mWriteAbs);
            if (p.cleanWrite) {
                for (int i = 0; i < n; ++i) {
                    mWriteRamp += rampCoef * (rampTarget - mWriteRamp);
                    const float sL = std::clamp(srcL[i], -1.5f, 1.5f);
                    const float sR = std::clamp(srcR[i], -1.5f, 1.5f);
                    mRingL[idx] = mRingL[idx] * (1.f - mWriteRamp) + sL * mWriteRamp;
                    mRingR[idx] = mRingR[idx] * (1.f - mWriteRamp) + sR * mWriteRamp;
                    if (++idx == sz) idx = 0;
                }
            } else {
                for (int i = 0; i < n; ++i) {
                    mWriteRamp += rampCoef * (rampTarget - mWriteRamp);
                    const float sL = std::tanh(srcL[i]);
                    const float sR = std::tanh(srcR[i]);
                    mRingL[idx] = mRingL[idx] * (1.f - mWriteRamp) + sL * mWriteRamp;
                    mRingR[idx] = mRingR[idx] * (1.f - mWriteRamp) + sR * mWriteRamp;
                    if (++idx == sz) idx = 0;
                }
            }
            mWriteAbs += n;
        } else {
            // Frozen hold: no writes — advance the seam ramp analytically so
            // a later resume still fades in smoothly.
            const float keep = std::pow(1.f - rampCoef, static_cast<float>(n));
            mWriteRamp = rampTarget + (mWriteRamp - rampTarget) * keep;
        }
    }

    // ── Display accessors (UI thread, lock-free, torn reads acceptable) ───────

    int64_t writeAbs() const { return mWriteAbs; }

    // Normalized display span: latched loop, else the trailing window.
    void displaySpan(int64_t trailingSamples, int64_t& start, int64_t& len) const {
        if (mLatched) { start = mLoopStartAbs; len = std::max<int64_t>(1, mLoopLen); return; }
        len   = std::max<int64_t>(1, std::min(trailingSamples, mRingSize));
        start = std::max<int64_t>(0, mWriteAbs - len);
    }

    // Strided SIGNED min/max scan over the display span — DAW-style waveform
    // columns (trough→peak per bucket), NOT peak magnitude: a magnitude
    // envelope of continuous music is near-uniform and rendered the LCD as a
    // solid block. Runs on the UI poll, never on the render thread. One lane
    // per channel (mono sources render identical lanes).
    void renderWaveform(float* minL, float* maxL, float* minR, float* maxR,
                        int buckets, int64_t trailingSamples) const {
        int64_t start = 0, len = 1;
        displaySpan(trailingSamples, start, len);
        const int64_t perBucket = std::max<int64_t>(1, len / buckets);
        const int64_t stride    = std::max<int64_t>(1, perBucket / 64);
        for (int b = 0; b < buckets; ++b) {
            const int64_t b0 = start + b * perBucket;
            float loL = 0.f, hiL = 0.f, loR = 0.f, hiR = 0.f;
            for (int64_t s = b0; s < b0 + perBucket; s += stride) {
                const size_t idx = ringIndex(s);
                const float vL = mRingL[idx];
                const float vR = mRingR[idx];
                loL = std::min(loL, vL); hiL = std::max(hiL, vL);
                loR = std::min(loR, vR); hiR = std::max(hiR, vR);
            }
            minL[b] = std::clamp(loL, -1.f, 1.f);
            maxL[b] = std::clamp(hiL, -1.f, 1.f);
            minR[b] = std::clamp(loR, -1.f, 1.f);
            maxR[b] = std::clamp(hiR, -1.f, 1.f);
        }
    }

    float playheadNorm(int64_t trailingSamples) const {
        int64_t start = 0, len = 1;
        displaySpan(trailingSamples, start, len);
        const double p = (mPlayheadAbs - static_cast<double>(start))
                       / static_cast<double>(len);
        return static_cast<float>(std::clamp(p, 0.0, 1.0));
    }

    float captureFill(int64_t trailingSamples) const {
        if (mLatched) return 1.f;
        if (trailingSamples <= 0) return 0.f;
        return std::min(1.f, static_cast<float>(mWriteAbs)
                           / static_cast<float>(trailingSamples));
    }

    // Copies voice state normalized to the display span. Returns voice count.
    int copyGrainDisplay(float* positions, float* amplitudes, float* pans,
                         float* pitches, int* actives, int maxCount,
                         int64_t trailingSamples) const {
        int64_t start = 0, len = 1;
        displaySpan(trailingSamples, start, len);
        const int count = std::min(maxCount, kMaxGrains);
        for (int i = 0; i < count; ++i) {
            const Grain& g = mVoices[static_cast<size_t>(i)];
            const double pos = (g.srcPos - static_cast<double>(start))
                             / static_cast<double>(len);
            positions[i]  = static_cast<float>(std::clamp(pos, 0.0, 1.0));
            amplitudes[i] = g.env;
            pans[i]       = g.pan;
            pitches[i]    = g.pitchSemis;
            actives[i]    = g.active ? 1 : 0;
        }
        return count;
    }

private:
    // xorshift32 → float in [0, 1).
    float frand() {
        mRng ^= mRng << 13; mRng ^= mRng >> 17; mRng ^= mRng << 5;
        return static_cast<float>(mRng >> 8) * (1.0f / 16777216.0f);
    }

    size_t ringIndex(int64_t abs) const {
        if (mRingSize <= 0) return 0;
        int64_t idx = abs % mRingSize;
        if (idx < 0) idx += mRingSize;
        return static_cast<size_t>(idx);
    }

    double wrapToLoop(double pos) const {
        if (mLoopLen <= 1) return pos;
        const double start = static_cast<double>(mLoopStartAbs);
        const double len   = static_cast<double>(mLoopLen);
        double off = std::fmod(pos - start, len);
        if (off < 0.0) off += len;
        return start + off;
    }

    void spawnGrain(const Params& p) {
        // Free voice, else steal the quietest (never refuse — density stays honest).
        Grain* slot = nullptr;
        float lowest = 2.f;
        for (auto& g : mVoices) {
            if (!g.active) { slot = &g; break; }
            if (g.env < lowest) { lowest = g.env; slot = &g; }
        }
        if (!slot) return;

        const float sr = static_cast<float>(mSampleRate);
        const uint32_t dur = static_cast<uint32_t>(std::clamp(
            p.sizeMs * 0.001f * sr, 64.f, sr * 2.f));

        // Pitch: knob + random offset (+ MIDI note / root transpose), then a
        // single key snap on the TOTAL so every contribution lands in key.
        float semis = p.pitchSemis;
        if (p.pitchRand > 0.001f)
            semis += (frand() * 2.f - 1.f) * 12.f * p.pitchRand;
        float noteGain = 1.f;
        if (p.midiPlay && p.noteCount > 0) {
            const int idx = static_cast<int>(mRng % static_cast<uint32_t>(
                std::clamp(p.noteCount, 1, 10)));
            semis   += p.noteSemis[idx];
            noteGain = (0.25f + 0.75f * std::clamp(p.noteVel[idx], 0.f, 1.f))
                     * std::clamp(p.noteEnv[idx], 0.f, 1.f);
        }
        semis += p.pitchOffsetSemis;
        if (p.pitchQuant) {
            // Snap keyRoot+total to the nearest enabled pitch class of the
            // global key mask (tie breaks upward), landing EXACTLY on the
            // note (fractional detune is consumed by the snap). MIDI notes
            // are already up-quantized by the kernel, so this only refines
            // texture/random contributions.
            const int mask = (p.keyMask & 0x0FFF) != 0 ? (p.keyMask & 0x0FFF) : 1;
            const int note = static_cast<int>(std::lround(p.keyRoot + semis));
            int snapped = note;
            for (int d = 0; d <= 6; ++d) {
                const int up = note + d, dn = note - d;
                if ((mask >> (((up % 12) + 12) % 12)) & 1) { snapped = up; break; }
                if (d > 0 && ((mask >> (((dn % 12) + 12) % 12)) & 1)) { snapped = dn; break; }
            }
            semis = static_cast<float>(snapped) - p.keyRoot;
        }
        semis = std::clamp(semis, -48.f, 48.f);
        const double ratio = std::exp2(static_cast<double>(semis) / 12.0)
                           * static_cast<double>(std::max(0.01f, p.clockRatio));
        const bool reversed = frand() < p.reverseProb;

        // Spawn position.
        double srcPos;
        if (mLatched && mLoopLen > 1) {
            const double sprayLen = p.spray * static_cast<double>(mLoopLen) * 0.5;
            srcPos = wrapToLoop(mPlayheadAbs + (frand() * 2.f - 1.f) * sprayLen);
        } else if (frozen(p)) {
            const double span  = std::max(1.0, mFreezeSpan);
            const double sprayLen = p.spray * span * 0.5;
            srcPos = mPlayheadAbs + (frand() * 2.f - 1.f) * sprayLen;
            const double start = static_cast<double>(mWriteAbs) - span;
            srcPos = std::clamp(srcPos, start, static_cast<double>(mWriteAbs) - 1.0);
        } else {
            // Live-roll: behind the write head, safety margin so the grain's
            // full read span (incl. pitch-up) can never cross the write head.
            const double safety = static_cast<double>(dur)
                                * std::max(1.0, std::abs(ratio)) + 256.0;
            const double window = std::max(1.0, mLiveSprayWindow);
            double base = static_cast<double>(mWriteAbs) - safety;
            base -= static_cast<double>(frand()) * p.spray * window;
            if (base < 256.0) return;   // ring not deep enough yet — clamping
                                        // to 0 piled correlated grains on the
                                        // same near-silent samples at song
                                        // start (the first-play crackle)
            srcPos = base;
        }
        if (reversed) {
            // Start at the far end and play back down — clamped below the
            // write head so a reversed start never reads unwritten ring.
            srcPos = std::min(srcPos + static_cast<double>(dur) * ratio,
                              static_cast<double>(mWriteAbs) - 1.0);
        }

        // BALANCE pan over the stereo source, POWER-NORMALIZED per grain
        // (aL²+aR² = 1): the grain carries the ring's stereo image while each
        // grain contributes the same total power as the old equal-power mono
        // pan. The un-normalized balance law passed ~2× power for centered
        // grains — correlated stacks then crossed the stage scrubber's trip
        // threshold, which RESETS THE RING, wiping the texture in a loop
        // (the post-stereo "faint output + red VU + refilling LCD" bug).
        // Gain normalized by expected overlap so density × size sweeps hold
        // level; kGrainMakeup compensates the Hann window energy loss.
        constexpr float kGrainMakeup = 1.8f;
        const float pan = (frand() * 2.f - 1.f) * std::clamp(p.spread, 0.f, 1.f);
        float aL = (pan <= 0.f) ? 1.f
                 : std::cos(pan * static_cast<float>(M_PI) * 0.5f);
        float aR = (pan >= 0.f) ? 1.f
                 : std::cos(-pan * static_cast<float>(M_PI) * 0.5f);
        const float norm = 1.f / std::sqrt(aL * aL + aR * aR);
        aL *= norm;
        aR *= norm;
        const float overlap = std::max(1.f, p.densityHz * static_cast<float>(dur) / sr);
        const float gain = kGrainMakeup * noteGain / std::sqrt(overlap);

        slot->active     = true;
        slot->srcPos     = srcPos;
        slot->srcInc     = reversed ? -ratio : ratio;
        slot->age        = 0;
        slot->dur        = dur;
        slot->winPhase   = 0.f;
        slot->winInc     = static_cast<float>(kWindowSize) / static_cast<float>(dur);
        slot->winIdx     = p.shape;
        slot->ampL       = aL * gain;
        slot->ampR       = aR * gain;
        slot->pan        = pan;
        slot->pitchSemis = semis;
        slot->env        = 0.f;
    }

public:
    // Live-mode spray window (display span), pushed by the kernel per block
    // from loopLength — public plain scalar, render-thread write only.
    double mLiveSprayWindow = 96000.0;

private:
    double  mSampleRate = 48000.0;
    int64_t mRingSize   = 0;
    std::vector<float> mRingL;
    std::vector<float> mRingR;
    std::vector<float> mGrainMono;
    std::array<std::array<float, kWindowSize + 1>, kNumWindows> mWindows {};
    std::array<Grain, kMaxGrains> mVoices {};

    int64_t mWriteAbs     = 0;
    bool    mLatched      = false;
    bool    mLoopPinned   = false;
    uint64_t mLoopGen     = 0;
    int64_t mLoopStartAbs = 0;
    int64_t mLoopLen      = 1;
    double  mPlayheadAbs  = 0.0;
    double  mFreezeSpan   = 48000.0;
    float   mWriteRamp    = 1.f;
    double  mCountdown    = 0.0;
    bool    mWasFrozen    = false;
    uint32_t mRng         = 0x9E3779B9u;
    std::atomic<bool> mCatchPending { false };
};
