//
//  GrainResonator.h
//  homecrate grain
//
//  Six-band quantized resonator, SMR-inspired (not a clone): the bands sit
//  on a note RING generated from a 12-key pitch-class mask (the vocal
//  keybed/pitchNoteMask pattern) spanning four octaves above a root note.
//  ROTATE spins the bands around the ring, SPREAD widens the gap between
//  neighbors (in ring steps), and MORPH glides each band's frequency toward
//  its target — so automating rotate/spread sweeps the bands through ONLY
//  the enabled keys, always landing quantized, with the glide making the
//  motion musical instead of steppy.
//
//  Each band is a Cytomic SVF bandpass (SVFilter.h topology, self-contained
//  here because the resonator needs unity-normalized output and a deeper Q
//  range than the shared copy's 0.1 damping floor). Per-band enable bits let
//  chords be thinned without touching the key mask.
//
//  RT contract (suite rules): header-only, no allocation, fixed arrays,
//  block-rate coefficient updates (6 tan calls per block), per-sample tanh
//  bound on the summed output so a hot high-Q ring can never blow up.
//

#pragma once

#include <algorithm>
#include <cmath>

class GrainResonator {
public:
    static constexpr int kBands    = 6;
    static constexpr int kMaxRing  = 64;
    static constexpr int kOctaves  = 4;

    struct Params {
        float mix      = 0.f;    // wet level added into the caller's bus — the gate
        float q        = 0.5f;   // 0 broad … 1 ringing
        float rotate   = 0.f;    // 0–1 = one full lap of the ring
        float spread   = 0.f;    // 0–1 → 0…4 extra ring steps between bands
        float morph    = 0.3f;   // 0–1 → 5 ms … 2 s frequency glide
        int   keyMask  = 2741;   // 12-bit pitch-class mask, bit 0 = C
        int   rootNote = 40;     // MIDI note of the ring's bottom (E2 default)
        int   bandMask = 63;     // per-band enable bits
    };

    void init(double sampleRate) {
        mSampleRate = (sampleRate > 1000.0) ? sampleRate : 48000.0;
        reset();
    }

    void reset() {
        for (int b = 0; b < kBands; ++b) {
            mBandL[b] = BandState{};
            mBandR[b] = BandState{};
            mFreq[b]  = 0.f;   // 0 = snap to target on first block (no glide-in)
        }
    }

    // ADDS the mix-scaled resonated signal into outL/outR (send/return
    // convention — dry passes untouched elsewhere).
    void process(const float* inL, const float* inR,
                 float* outL, float* outR, int n, const Params& p) {
        if (p.mix <= 0.0001f || n <= 0) {
            // Inactive: decay the states so re-enabling never replays a stale
            // ring (reset-on-edge is overkill for stateless-feedback SVFs —
            // a cheap decay per block keeps them silent and click-free).
            // Once everything is at the noise floor, stop touching state
            // entirely (perf pass: idle = zero work).
            if (mIdleSilent) return;
            float mag = 0.f;
            for (int b = 0; b < kBands; ++b) {
                mBandL[b].ic1 *= 0.5f; mBandL[b].ic2 *= 0.5f;
                mBandR[b].ic1 *= 0.5f; mBandR[b].ic2 *= 0.5f;
                mag = std::max({mag, std::abs(mBandL[b].ic1), std::abs(mBandL[b].ic2),
                                     std::abs(mBandR[b].ic1), std::abs(mBandR[b].ic2)});
            }
            if (mag < 1e-7f) mIdleSilent = true;
            return;
        }
        mIdleSilent = false;

        // ── Note ring from the key mask (quantization source of truth) ────────
        const int mask = (p.keyMask & 0x0FFF) != 0 ? (p.keyMask & 0x0FFF) : 1;
        int ring[kMaxRing];
        int len = 0;
        const int root = std::clamp(p.rootNote, 12, 96);
        for (int note = root; note < root + 12 * kOctaves && len < kMaxRing; ++note) {
            if ((mask >> (note % 12)) & 1) ring[len++] = note;
        }
        if (len < 1) { ring[0] = root; len = 1; }

        // ── Band targets + block-rate coefficient update ──────────────────────
        // Damping: q 0 → K 1.2 (broad band), q 1 → K 0.015 (long ring, Q≈66).
        const float k = 1.2f * std::pow(0.0125f, std::clamp(p.q, 0.f, 1.f));
        // Morph glide: block-rate one-pole toward the target frequency.
        const float morphSec = 0.005f * std::pow(400.f, std::clamp(p.morph, 0.f, 1.f));
        const float blockSec = static_cast<float>(n) / static_cast<float>(mSampleRate);
        const float slew     = 1.f - std::exp(-blockSec / std::max(morphSec, 1e-4f));
        const float step     = 1.f + std::clamp(p.spread, 0.f, 1.f) * 4.f;

        int active = 0;
        float a1[kBands], a2[kBands], a3[kBands], kNorm[kBands];
        bool  on[kBands];
        for (int b = 0; b < kBands; ++b) {
            on[b] = ((p.bandMask >> b) & 1) != 0;
            if (!on[b]) { a1[b] = a2[b] = a3[b] = kNorm[b] = 0.f; continue; }
            active += 1;

            const float pos = p.rotate * static_cast<float>(len)
                            + static_cast<float>(b) * step;
            int idx = static_cast<int>(std::floor(pos)) % len;
            if (idx < 0) idx += len;
            const int note = ring[std::clamp(idx, 0, kMaxRing - 1)];
            const float target = std::clamp(
                440.f * std::exp2((static_cast<float>(note) - 69.f) / 12.f),
                30.f, 12000.f);

            if (mFreq[b] <= 0.f) mFreq[b] = target;               // first block: snap
            mFreq[b] += slew * (target - mFreq[b]);

            // Cytomic SVF coefficients (fastTan Padé, SVFilter.h precedent).
            const float w  = static_cast<float>(M_PI) * mFreq[b]
                           / static_cast<float>(mSampleRate);
            const float w2 = w * w;
            const float g  = w * (15.f - w2) / (15.f - 6.f * w2);
            a1[b] = 1.f / (1.f + g * (g + k));
            a2[b] = g * a1[b];
            a3[b] = g * a2[b];
            // √k·v1 = CONSTANT-ENERGY normalization (peak gain 1/√k at
            // center), NOT unity-peak (k·v1): unity-peak made narrow high-Q
            // bands whisper-quiet — only a sliver of spectrum passed at
            // unity, and raising Q narrowed the sliver, so diming the knobs
            // got QUIETER (device feedback 2026-07-31). With √k the bands
            // ring louder as they narrow — the SMR-style behavior.
            kNorm[b] = std::sqrt(k);
        }
        if (active == 0) return;

        // +6 dB makeup after the √active spread — the tanh bound below keeps
        // hot rings musical instead of letting them clip.
        const float bandGain = 2.0f / std::sqrt(static_cast<float>(active));
        const float mix = std::clamp(p.mix, 0.f, 1.f);

        for (int f = 0; f < n; ++f) {
            const float xl = inL[f];
            const float xr = inR[f];
            float sl = 0.f, sr = 0.f;
            for (int b = 0; b < kBands; ++b) {
                if (!on[b]) continue;
                sl += kNorm[b] * bandTick(mBandL[b], xl, a1[b], a2[b], a3[b]);
                sr += kNorm[b] * bandTick(mBandR[b], xr, a1[b], a2[b], a3[b]);
            }
            // Soft bound: a hot high-Q ring saturates musically, never blows up.
            outL[f] += std::tanh(sl * bandGain) * mix;
            outR[f] += std::tanh(sr * bandGain) * mix;
        }
    }

private:
    struct BandState { float ic1 = 0.f; float ic2 = 0.f; };

    // One Cytomic SVF step returning the raw bandpass (v1).
    static inline float bandTick(BandState& s, float input, float a1, float a2, float a3) {
        const float v3 = input - s.ic2;
        const float v1 = a1 * s.ic1 + a2 * v3;
        const float v2 = s.ic2 + a2 * s.ic1 + a3 * v3;
        s.ic1 = 2.f * v1 - s.ic1;
        s.ic2 = 2.f * v2 - s.ic2;
        return v1;
    }

    double mSampleRate = 48000.0;
    BandState mBandL[kBands];
    BandState mBandR[kBands];
    float mFreq[kBands] = {};
    bool  mIdleSilent   = false;
};
