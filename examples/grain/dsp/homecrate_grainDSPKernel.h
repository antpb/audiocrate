//
//  homecrate_grainDSPKernel.h
//  homecrate grain — VST3 port
//
//  Declaration only — heavy DSP headers are never included here.
//  GrainEngine / CostelloReverbEngine / AmpDelayEngine / LofiEngine are used
//  only as raw pointers (forward-declared), so this header is safe to include
//  from the Swift bridging header. All method bodies live in
//  homecrate_grainDSPKernel.mm.
//
//  Signal flow (dry is NEVER processed past DRIVE; every wet path is an
//  additive layer defaulting to 0 → untouched insert = exact passthrough):
//
//    in ×inputGain → DRIVE → dry ─────────────────────────────────┐
//      capture tap (STEREO) → RINGS → GRAIN ENGINE → grain bus    │
//      delay SEND {input | grains | both} → AmpDelayEngine (100%  │
//      wet return) → ROUTE {out | →reverb | →ring | →wash}        │
//      wet = grains×mix (+delay per route) → REVERB send/return   │
//      → WASH (lofi macro) → out = dry + wet → GLUE → clamp ──────┘
//

#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <utility>
#include <vector>

// AU-compatible aliases (VST3 port — keeps the body diffable with the AUv3).
typedef uint64_t AUParameterAddress;
typedef float    AUValue;
typedef uint32_t AUAudioFrameCount;
typedef int64_t  AUEventSampleTime;

struct KernelSpinLock {
    std::atomic_flag flag = ATOMIC_FLAG_INIT;
    bool try_lock() { return !flag.test_and_set(std::memory_order_acquire); }
    void lock()     { while (flag.test_and_set(std::memory_order_acquire)) {} }
    void unlock()   { flag.clear(std::memory_order_release); }
};

#include "homecrate_grainParameterAddresses.h"

// Forward declarations — full types only needed in the .mm.
class GrainEngine;
class GrainResonator;
class CostelloReverbEngine;
class AmpDelayEngine;   // per-target copy lives in GrainDelayEngine.h (class name kept)
class LofiEngine;

// ── LCD visualization PODs (synth SynthVoiceDisplayInfo precedent) ────────────
// C-layout, bridging-header visible; copied out lock-free at 30 Hz by the
// in-process editor. int (not bool) for stable C layout across interop.

struct GrainDisplayInfo {
    float position;    // 0–1 across the displayed span
    float amplitude;   // current window envelope, 0–1
    float pan;         // −1…+1
    float pitchSemis;  // color/size coding on the LCD
    int   active;
};

struct GrainBufferDisplayState {
    // DAW-style signed min/max waveform columns per channel over the
    // displayed span (L lane above, R lane below; mono renders identical).
    float waveMinL[128];
    float waveMaxL[128];
    float waveMinR[128];
    float waveMaxR[128];
    float writeHead;      // 1.0 live ("now" at the right edge); −1 latched
    float playHead;       // 0–1 frozen/latched playhead; −1 when rolling
    float captureFill;    // 0–1 ring fill toward the display span
    float loopStart;      // 0 when latched (span IS the loop); −1 otherwise
    float loopLength;     // latched loop ÷ max loopLength (5 s); 0 = none
    int   frozen;
    int   mode;           // 0 live-rolling, 1 catch-armed (rolling), 2 latched
    int   overdubbing;
    float inputLevel;     // dry envelope (the CROSS follower, free meter)
    float wetLevel;       // wet bus envelope
    float clockRatio;     // current CLOCK multiplier
};

class homecrate_grainDSPKernel {
public:

    homecrate_grainDSPKernel() = default;

    // Destructor is non-trivial (deletes raw DSP pointers); body in .mm.
    ~homecrate_grainDSPKernel();

    // Non-copyable.
    homecrate_grainDSPKernel(const homecrate_grainDSPKernel&)            = delete;
    homecrate_grainDSPKernel& operator=(const homecrate_grainDSPKernel&) = delete;

    // (The AUv3's Swift-interop move constructor is deleted in the VST3 port —
    // the processor holds the kernel by value, default-constructed.)
    homecrate_grainDSPKernel(homecrate_grainDSPKernel&&) = delete;
    homecrate_grainDSPKernel& operator=(homecrate_grainDSPKernel&&) = delete;

    // MARK: - Lifecycle
    void initialize(int inputChannelCount, int outputChannelCount, double inSampleRate);
    void deInitialize();

    // MARK: - Bypass
    bool isBypassed();
    void setBypass(bool shouldBypass);

    // MARK: - Parameters
    void setParameter(AUParameterAddress address, AUValue value);
    AUValue getParameter(AUParameterAddress address);

    // MARK: - Max frames
    AUAudioFrameCount maximumFramesToRender() const;
    void setMaximumFramesToRender(const AUAudioFrameCount& maxFrames);

    // MARK: - Host tempo (per block from the VST3 ProcessContext)
    void setHostBPM(double bpm);

    // MARK: - Process  (real-time thread)
    void process(const float* const* inputBuffers,  int numInputs,
                 float* const*       outputBuffers, int numOutputs,
                 AUEventSampleTime   bufferStartTime,
                 AUAudioFrameCount   frameCount);

    // MARK: - Event handling (fed directly by the VST3 processor)
    // catchCC toggles the loop latch, freezeCC holds freeze while down,
    // oscillateCC is the delay-runaway momentary (vocal precedent).
    void handleMIDIControlChange(int cc, bool on);
    // Note input for the MIDI modes (Play = held notes gate + pitch grains,
    // Root = latching cloud transpose). Render-thread only.
    void handleNoteOn(int note, float velocity);
    void handleNoteOff(int note);

    // MARK: - LCD visualization (UI thread, lock-free copy-out)
    void getGrainDisplayInfo(GrainDisplayInfo* outInfo, int count) const;
    void getBufferDisplayState(GrainBufferDisplayState* outState) const;

    // MARK: - Loop persistence (main/load thread; kernel lock held inside —
    // the render thread trylocks and copy-throughs, initialize() contract).
    // Push decoded samples as a PINNED latched loop (file import / project
    // restore / reload). Mono sources pass nullptr for R (duplicated).
    // Pinned loops ignore catch-toggle release.
    void loadLoopSamples(const float* dataL, const float* dataR, int count);
    // Un-pin and release the latch (the eject button).
    void releaseLoop();
    // Copy the latched loop for saving. Returns frames copied (0 = none).
    int copyLoopSamples(float* dstL, float* dstR, int maxCount);
    bool loopLatched() const;
    uint64_t loopGeneration() const;

    // MARK: - Chain health (UI/diagnostic, main thread)
    uint32_t debugScrubInCount();
    uint32_t debugScrubFxCount();

    // MARK: - Render perf (UI/diagnostic, main thread — relaxed atomic reads).
    // Average / peak process() wall time in ns, published ~1×/sec of audio.
    uint64_t perfAvgNs();
    uint64_t perfPeakNs();

    // MARK: - Public member variables
    double            mSampleRate        = 48000.0;
    bool              mBypassed          = false;
    AUAudioFrameCount mMaxFramesToRender = 4096;

    // 0→1 output ramp applied at engine start (anti-crackle, suite precedent).
    int               mFadeInSamples     = 1024;

private:
    // Once-per-block refreshes (vocal patterns): dirty params + BPM sync +
    // momentary oscillate for the delay; reverb tank push; wash activity/edge;
    // catch-length resolve (free seconds vs. beat-sync).
    void refreshDelay();
    void refreshReverb();
    void refreshWash();
    void resolveLoopLen();
    // Advance one kernel-owned LFO by n samples and return its shaped bipolar
    // value ×depth (0 when target Off / depth ~0 — phase holds still).
    float tickLfo(double& phase, float& shValue, uint32_t& rng,
                  int target, int shape, float depth,
                  bool sync, int division, float rateHz, int n);

    mutable KernelSpinLock mLock;

    std::atomic<double> mHostBPM { 0.0 };   // 0 = host reported no tempo

    float mInputGain   = 1.f;
    float mOutputGain  = 1.f;
    float mDriveAmount = 0.f;
    // Dry at the FINAL sum only — the capture tap, delay send and reverb
    // dry-feed all stay pre-fader (console send semantics), so sinking the
    // dry washes the player out without starving the texture engines.
    float mDryLevel    = 1.f;

    // ── Capture / micro-looper mirrors ────────────────────────────────────────
    int   mCaptureMode   = 0;
    bool  mFreezeHold    = false;
    float mLoopLength    = 2.0f;    // seconds
    bool  mLoopSync      = false;
    int   mLoopDivision  = 2;       // {1/2, 1, 2, 4, 8} beats
    bool  mLoopOverdub   = false;
    float mLoopFade      = 0.f;
    int   mCaptureSource = 0;
    // Render/param-thread edge tracker for the momentary catch toggle.
    bool  mCatchParamOn  = false;

    // ── Grain mirrors ─────────────────────────────────────────────────────────
    float mGrainMix        = 0.f;
    float mGrainSize       = 120.f;
    float mGrainDensity    = 18.f;
    float mGrainSpray      = 0.25f;
    float mGrainPitch      = 0.f;
    bool  mGrainPitchQuant = false;
    float mGrainPitchRand  = 0.f;
    float mGrainReverse    = 0.f;
    float mGrainSpread     = 0.6f;
    int   mGrainShape      = 0;
    float mGrainFeedback   = 0.f;
    float mGrainScan       = 1.f;
    int   mGrainClock      = 0;
    int   mCrossTarget     = 0;
    float mCrossAmount     = 0.5f;
    // Grain-bus tone: 0.5 neutral, left = one-pole LP darken, right = HP
    // thin. Applied pre-send so delayed/reverbed grains inherit it.
    float mGrainTone       = 0.5f;
    float mToneLpL = 0.f, mToneLpR = 0.f;   // render-thread filter state
    float mToneHpL = 0.f, mToneHpR = 0.f;
    // Input DC blocker (~4 Hz, post-gain / pre-drive). Upstream NAM amp
    // models emit DC; the reverb/delay feedback loops INTEGRATE a constant
    // input ×20–33 and grains stack windowed copies — output pinned at the
    // rail (red VU, inaudible, audio progressively clipped), ring/LCD full.
    float mDcX1L = 0.f, mDcY1L = 0.f;
    float mDcX1R = 0.f, mDcY1R = 0.f;

    // ── MIDI note modes (render-thread state — MIDI events and process()
    // share the render thread, so plain members are safe) ────────────────────
    // Play-mode notes are SLOTS with a per-note attack/release envelope: a
    // released key stays active (grains keep spawning at decaying level)
    // until its envelope dies, so the layer rings out instead of hard-gating.
    static constexpr int kMaxHeldNotes = 10;
    struct NoteSlot {
        uint8_t note   = 0;
        float   vel    = 0.f;
        float   env    = 0.f;   // block-rate one-pole, attack→1 / release→0
        bool    held   = false;
        bool    active = false; // false once the release tail dies
    };
    int   mMidiMode    = 0;    // 0 Off / 1 Play / 2 Root
    float mMidiRoot    = 60.f;
    float mMidiAttack  = 5.f;    // ms
    float mMidiRelease = 250.f;  // ms
    std::array<NoteSlot, kMaxHeldNotes> mNoteSlots {};
    int   mLatchedNote = -1;   // Root mode latch: last note played, held after release

    // ── Delay send mirrors (vocal cluster semantics) ──────────────────────────
    float mDelayTime      = 350.f;
    float mDelayFeedback  = 0.35f;
    float mDelayTone      = 0.7f;
    float mDelayLevel     = 0.f;
    bool  mDelaySync      = false;
    int   mDelayDivision  = 1;
    bool  mDelayPingPong  = false;
    bool  mDelayTape      = false;
    bool  mDelayDuck      = false;
    int   mDelaySend      = 0;
    int   mDelayRoute     = 0;
    bool  mDelayOscillate = false;
    std::atomic<bool> mDelayDirty { true };

    // ── Reverb mirrors ────────────────────────────────────────────────────────
    float mReverbDecay    = 0.5f;
    float mReverbBlend    = 0.f;
    float mReverbSize     = 1.0f;
    float mReverbPreDelay = 10.f;
    float mReverbTone     = 0.7f;
    float mReverbDryFeed  = 0.f;
    std::atomic<bool> mReverbDirty { true };

    // ── Wash / glue mirrors ───────────────────────────────────────────────────
    float mWashAmount = 0.f;
    float mWashWarble = 0.f;
    int   mWashMode   = 0;
    float mGlueAmount = 0.f;

    // ── User-assignable CC numbers ────────────────────────────────────────────
    float mCatchCCNum  = 24.f;
    float mFreezeCCNum = 25.f;
    float mOscCCNum    = 27.f;

    // ── Resonator mirrors (SMR-inspired quantized 6-band) ─────────────────────
    float mResMix      = 0.f;
    float mResQ        = 0.5f;
    float mResRotate   = 0.f;
    float mResSpread   = 0.f;
    int   mKeyMask  = 2741;   // C major (pitchNoteMask precedent)
    float mResRoot     = 40.f;   // E2
    float mResMorph    = 0.3f;
    int   mResBandMask = 63;
    int   mResSend     = 2;      // Input+Grains

    // ── Assignable LFOs (vocal lofi-LFO pattern: kernel-owned phase, xorshift
    // S&H — NEVER rand() on the render thread; block-rate application) ────────
    int   mResLfoTarget    = 0;
    float mResLfoRate      = 1.f;
    bool  mResLfoSync      = false;
    int   mResLfoDivision  = 1;
    int   mResLfoShape     = 0;
    float mResLfoDepth     = 0.f;
    int   mGrainLfoTarget   = 0;
    float mGrainLfoRate     = 1.f;
    bool  mGrainLfoSync     = false;
    int   mGrainLfoDivision = 1;
    int   mGrainLfoShape    = 0;
    float mGrainLfoDepth    = 0.f;
    // Render-thread LFO state.
    double   mResLfoPhase   = 0.0;
    float    mResLfoSH      = 0.f;
    uint32_t mResLfoRng     = 0x7C3A9E15u;
    double   mGrainLfoPhase = 0.0;
    float    mGrainLfoSH    = 0.f;
    uint32_t mGrainLfoRng   = 0x2B8D17F3u;

    // ── Render-thread-only state ──────────────────────────────────────────────
    float   mCrossEnv      = 0.f;   // instant-attack / 200 ms-release dry follower
    float   mCrossRelease  = 0.f;   // per-sample one-pole coeff, set at initialize()
    bool    mWashActive    = false;
    bool    mWashWasActive = false;
    int     mWashPrevMode  = 0;
    int64_t mLoopLenSamples = 96000;
    // Tail-drain skip counters for the always-running feedback engines: when
    // a section goes inactive its line is fed SILENCE until the tail has
    // fully drained, then reset once and skipped — never frozen with content
    // (the documented "massive pop" bug), never burning CPU at idle either.
    int64_t mVerbIdleSamples  = 0;
    int64_t mDelayIdleSamples = 0;
    // Grain-render skip edge tracker (sleep() the voices once on the edge).
    bool    mGrainWasConsumed = true;

    std::atomic<int>   mFadeInRemaining { 0 };
    std::atomic<float> mInputLevel { 0.f };   // display meters
    std::atomic<float> mWetLevel   { 0.f };

    // Chain engines — allocated eagerly in initialize(), never swapped, so the
    // render path stays lock-free w.r.t. engines (vocal precedent).
    GrainEngine*          mGrain   = nullptr;
    GrainResonator*       mReso    = nullptr;
    AmpDelayEngine*       mDelay   = nullptr;
    CostelloReverbEngine* mReverb  = nullptr;
    CostelloReverbEngine* mReverbR = nullptr;
    LofiEngine*           mLofiL   = nullptr;
    LofiEngine*           mLofiR   = nullptr;

    // Working buffers, sized in initialize()/setMaximumFramesToRender().
    std::vector<float> mDryL, mDryR;           // post-drive dry (untouched after)
    std::vector<float> mGrainBusL, mGrainBusR; // grain engine output
    std::vector<float> mSendL, mSendR;         // delay send bus → wet return in-place
    std::vector<float> mWetL, mWetR;           // additive wet sum
    std::vector<float> mVerbL, mVerbR;         // reverb send/return scratch
    std::vector<float> mRingSrcL, mRingSrcR;   // composed STEREO capture source

    // Render-thread perf counters — published to atomics ~once per second of
    // audio (NEVER os_log'd from the render thread — the "interval pop").
    struct PerfStats {
        uint64_t callCount   = 0;
        uint64_t framesAccum = 0;
        uint64_t totalNs     = 0;
        uint64_t grainNs     = 0;
        uint64_t peakTotalNs = 0;
    };
    PerfStats mPerf;
    std::atomic<uint64_t> mPerfAvgNs  { 0 };
    std::atomic<uint64_t> mPerfPeakNs { 0 };

    // Stage-scrubber trip counters + one-shot null-pull log guard.
    std::atomic<uint32_t> mScrubIn { 0 };
    std::atomic<uint32_t> mScrubFx { 0 };
    std::atomic<bool>     mNullPullLogged { false };
};
