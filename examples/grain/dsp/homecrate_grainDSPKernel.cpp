//
//  homecrate_grainDSPKernel.cpp
//  homecrate grain — VST3 port
//
//  Faithful port of the AUv3 .mm. DSP is intentionally identical; only the
//  host seams differ (spinlock, ProcessContext tempo via setHostBPM, chrono
//  perf clock, scalar max-mag instead of vDSP, no CoreMIDI/os_log).
//
//  Dry passes at unity and is never processed past DRIVE; grains, delay,
//  reverb and wash are additive layers whose levels all default to 0, so an
//  untouched insert is exact passthrough (suite convention).
//

#include "homecrate_grainDSPKernel.h"

// Chain engines — only included in this .mm file.
#include "GrainEngine.h"
#include "GrainResonator.h"
#include "CostelloReverbEngine.h"
#include "GrainDelayEngine.h"
#include "LofiEngine.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Monotonic nanoseconds (replaces mach_absolute_time × timebase factor).
static inline uint64_t hcNowNs() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count());
}

// Scalar max-magnitude (replaces vDSP_maxmgv — three garbage-detector sites).
static inline float hcMaxMag(const float* p, int n) {
    float m = 0.f;
    for (int i = 0; i < n; ++i) {
        const float a = std::fabs(p[i]);
        if (a > m) m = a;
    }
    return m;
}

// CLOCK: repitch multiplier per step {Full, −5th, −Oct, −2Oct}. Steps ≥ 1 also
// degrade: ZOH grain reads; steps ≥ 2 add a crush floor to the WASH stage.
static constexpr float kClockRatios[4] = { 1.0f, 0.667f, 0.5f, 0.25f };

static float clockCrushFloor(int step) {
    if (step >= 3) return 0.30f;
    if (step == 2) return 0.15f;
    return 0.f;
}

// Global-key MIDI quantize: notes on disabled keys move UP to the nearest
// enabled pitch class, so the player can hit anything and land in key.
// Applied at use-time (not at note-on), so editing the keybed re-quantizes
// held notes live.
static int quantizeNoteUp(int note, int mask) {
    mask &= 0x0FFF;
    if (mask == 0) return note;
    for (int d = 0; d < 12; ++d) {
        if ((mask >> ((note + d) % 12)) & 1) return note + d;
    }
    return note;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

homecrate_grainDSPKernel::~homecrate_grainDSPKernel() {
    delete mGrain;   mGrain   = nullptr;
    delete mReso;    mReso    = nullptr;
    delete mDelay;   mDelay   = nullptr;
    delete mReverb;  mReverb  = nullptr;
    delete mReverbR; mReverbR = nullptr;
    delete mLofiL;   mLofiL   = nullptr;
    delete mLofiR;   mLofiR   = nullptr;
}

void homecrate_grainDSPKernel::initialize(int inputChannelCount, int outputChannelCount, double inSampleRate) {

    // Hold the kernel lock for the whole rebuild: the render thread only
    // trylocks, so a concurrent process() falls into its copy-through path
    // instead of reading engine vectors mid-reallocation (that race aborted
    // the vocal extension under OS 26's bounds-checked vector[]).
    mLock.lock();
    mSampleRate = inSampleRate;
    const size_t frames = mMaxFramesToRender;
    mDryL.assign(frames, 0.f);      mDryR.assign(frames, 0.f);
    mGrainBusL.assign(frames, 0.f); mGrainBusR.assign(frames, 0.f);
    mSendL.assign(frames, 0.f);     mSendR.assign(frames, 0.f);
    mWetL.assign(frames, 0.f);      mWetR.assign(frames, 0.f);
    mVerbL.assign(frames, 0.f);     mVerbR.assign(frames, 0.f);
    mRingSrcL.assign(frames, 0.f);  mRingSrcR.assign(frames, 0.f);

    mCrossEnv     = 0.f;
    mCrossRelease = 1.f - std::exp(-1.f / (0.2f * static_cast<float>(mSampleRate)));
    mDcX1L = mDcY1L = mDcX1R = mDcY1R = 0.f;

    // Clear MIDI note state — a stop/restart must never resurrect held notes.
    for (auto& s : mNoteSlots) s = NoteSlot{};
    mLatchedNote = -1;

    mDelayDirty.store(true, std::memory_order_relaxed);
    mReverbDirty.store(true, std::memory_order_relaxed);
    mWashWasActive = false;
    mWashPrevMode  = mWashMode;

    // Engines — eager and never swapped, so the render path stays lock-free
    // (vocal precedent). Redundant re-init after a stop/restart is cheap.
    if (!mGrain) mGrain = new GrainEngine();
    mGrain->init(mSampleRate, static_cast<int>(mMaxFramesToRender));

    if (!mReso) mReso = new GrainResonator();
    mReso->init(mSampleRate);

    if (!mDelay) mDelay = new AmpDelayEngine();
    mDelay->init(mSampleRate);
    // Send/return: the engine's internal mix stays pinned at 1.0 forever so
    // processStereo() returns pure wet while the send bus still feeds the
    // line. Routing and level happen OUTSIDE the engine (delayLevel/delayRoute).
    mDelay->setMix(1.0f);

    if (!mReverb)  mReverb  = new CostelloReverbEngine();
    if (!mReverbR) mReverbR = new CostelloReverbEngine();
    mReverb->setup(mSampleRate);
    mReverbR->setup(mSampleRate);

    if (!mLofiL) mLofiL = new LofiEngine();
    if (!mLofiR) mLofiR = new LofiEngine();
    mLofiL->init(mSampleRate, 0x51A3D7E1u);
    mLofiR->init(mSampleRate, 0x0C0FFEE5u);

    // Engines start fresh, so the tail-drain skips begin in the "already
    // drained" state — an idle insert costs nothing from the first block.
    mVerbIdleSamples  = INT64_MAX / 2;
    mDelayIdleSamples = INT64_MAX / 2;
    mGrainWasConsumed = true;

    // Every session starts with a short 0→1 ramp (anti-crackle, suite precedent).
    mFadeInRemaining.store(mFadeInSamples, std::memory_order_relaxed);

    mPerf = {};
    mLock.unlock();
}

void homecrate_grainDSPKernel::deInitialize() {
}

// ── Bypass ────────────────────────────────────────────────────────────────────

bool homecrate_grainDSPKernel::isBypassed()                { return mBypassed; }
void homecrate_grainDSPKernel::setBypass(bool shouldBypass){ mBypassed = shouldBypass; }

uint32_t homecrate_grainDSPKernel::debugScrubInCount() {
    return mScrubIn.load(std::memory_order_relaxed);
}

uint32_t homecrate_grainDSPKernel::debugScrubFxCount() {
    return mScrubFx.load(std::memory_order_relaxed);
}

uint64_t homecrate_grainDSPKernel::perfAvgNs() {
    return mPerfAvgNs.load(std::memory_order_relaxed);
}

uint64_t homecrate_grainDSPKernel::perfPeakNs() {
    return mPerfPeakNs.load(std::memory_order_relaxed);
}

// ── Parameters ────────────────────────────────────────────────────────────────

void homecrate_grainDSPKernel::setParameter(AUParameterAddress address, AUValue value) {
    switch (address) {
        case homecrate_grainParameterAddress::inputGain:   mInputGain   = value; break;
        case homecrate_grainParameterAddress::outputGain:  mOutputGain  = value; break;
        case homecrate_grainParameterAddress::driveAmount: mDriveAmount = value; break;
        case homecrate_grainParameterAddress::dryLevel:
            mDryLevel = std::clamp(value, 0.f, 1.f);
            break;

        case homecrate_grainParameterAddress::captureMode:
            mCaptureMode = std::clamp(static_cast<int>(value + 0.5f), 0, 1);
            break;
        case homecrate_grainParameterAddress::catchTrigger: {
            // Momentary toggle: only the rising edge latches/releases.
            const bool on = (value >= 0.5f);
            if (on && !mCatchParamOn && mGrain) mGrain->requestCatchToggle();
            mCatchParamOn = on;
            break;
        }
        case homecrate_grainParameterAddress::freezeHold:
            mFreezeHold = (value >= 0.5f);
            break;
        case homecrate_grainParameterAddress::loopLength:
            mLoopLength = std::clamp(value, 0.25f, 5.0f);
            break;
        case homecrate_grainParameterAddress::loopSync:
            mLoopSync = (value >= 0.5f);
            break;
        case homecrate_grainParameterAddress::loopDivision:
            mLoopDivision = std::clamp(static_cast<int>(value + 0.5f), 0, 4);
            break;
        case homecrate_grainParameterAddress::loopOverdub:
            mLoopOverdub = (value >= 0.5f);
            break;
        case homecrate_grainParameterAddress::loopFade:
            mLoopFade = value;
            break;
        case homecrate_grainParameterAddress::captureSource:
            mCaptureSource = std::clamp(static_cast<int>(value + 0.5f), 0, 2);
            break;

        case homecrate_grainParameterAddress::grainMix:        mGrainMix       = value; break;
        case homecrate_grainParameterAddress::grainSize:       mGrainSize      = value; break;
        case homecrate_grainParameterAddress::grainDensity:    mGrainDensity   = value; break;
        case homecrate_grainParameterAddress::grainSpray:      mGrainSpray     = value; break;
        case homecrate_grainParameterAddress::grainPitch:      mGrainPitch     = value; break;
        case homecrate_grainParameterAddress::grainPitchQuant: mGrainPitchQuant = (value >= 0.5f); break;
        case homecrate_grainParameterAddress::grainPitchRand:  mGrainPitchRand = value; break;
        case homecrate_grainParameterAddress::grainReverse:    mGrainReverse   = value; break;
        case homecrate_grainParameterAddress::grainSpread:     mGrainSpread    = value; break;
        case homecrate_grainParameterAddress::grainShape:
            mGrainShape = std::clamp(static_cast<int>(value + 0.5f), 0, 3);
            break;
        case homecrate_grainParameterAddress::grainFeedback:
            mGrainFeedback = std::clamp(value, 0.f, 0.9f);
            break;
        case homecrate_grainParameterAddress::grainScan:       mGrainScan      = value; break;
        case homecrate_grainParameterAddress::grainClock:
            mGrainClock = std::clamp(static_cast<int>(value + 0.5f), 0, 3);
            break;
        case homecrate_grainParameterAddress::crossTarget:
            mCrossTarget = std::clamp(static_cast<int>(value + 0.5f), 0, 4);
            break;
        case homecrate_grainParameterAddress::crossAmount:     mCrossAmount    = value; break;
        case homecrate_grainParameterAddress::grainTone:       mGrainTone      = value; break;
        case homecrate_grainParameterAddress::midiMode:
            mMidiMode = std::clamp(static_cast<int>(value + 0.5f), 0, 2);
            if (mMidiMode != 2) mLatchedNote = -1;   // leaving Root drops the latch
            break;
        case homecrate_grainParameterAddress::midiRoot:
            mMidiRoot = std::clamp(value, 0.f, 127.f);
            break;
        case homecrate_grainParameterAddress::midiAttack:
            mMidiAttack = std::clamp(value, 1.f, 2000.f);
            break;
        case homecrate_grainParameterAddress::midiRelease:
            mMidiRelease = std::clamp(value, 5.f, 5000.f);
            break;

        case homecrate_grainParameterAddress::delayTime:
            mDelayTime = value;
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::delayFeedback:
            mDelayFeedback = value;
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::delayTone:
            mDelayTone = value;
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::delayLevel:
            // Wet-return level applied in the kernel mix — NOT the engine's
            // internal mix, which stays pinned at 1.0 (send/return contract).
            mDelayLevel = value;
            break;
        case homecrate_grainParameterAddress::delaySync:
            mDelaySync = (value >= 0.5f);
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::delayDivision:
            mDelayDivision = std::clamp(static_cast<int>(value + 0.5f), 0, 6);
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::delayPingPong:
            mDelayPingPong = (value >= 0.5f);
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::delayTape:
            mDelayTape = (value >= 0.5f);
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::delayDuck:
            mDelayDuck = (value >= 0.5f);
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::delaySend:
            mDelaySend = std::clamp(static_cast<int>(value + 0.5f), 0, 2);
            break;
        case homecrate_grainParameterAddress::delayRoute:
            mDelayRoute = std::clamp(static_cast<int>(value + 0.5f), 0, 3);
            break;
        case homecrate_grainParameterAddress::delayOscillate:
            // Momentary — plain bool write, RT-safe (vocal precedent).
            mDelayOscillate = (value >= 0.5f);
            break;

        case homecrate_grainParameterAddress::reverbDecay:
            mReverbDecay = value;
            mReverbDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::reverbBlend:
            // Wet-return level applied in the kernel mix — the tank's own
            // blend stays pinned at 1.0 (send/return contract).
            mReverbBlend = value;
            break;
        case homecrate_grainParameterAddress::reverbSize:
            mReverbSize = value;
            mReverbDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::reverbPreDelay:
            mReverbPreDelay = value;
            mReverbDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::reverbTone:
            mReverbTone = value;
            mReverbDirty.store(true, std::memory_order_release);
            break;
        case homecrate_grainParameterAddress::reverbDryFeed:
            mReverbDryFeed = value;
            break;

        case homecrate_grainParameterAddress::washAmount: mWashAmount = value; break;
        case homecrate_grainParameterAddress::washWarble: mWashWarble = value; break;
        case homecrate_grainParameterAddress::washMode:
            mWashMode = std::clamp(static_cast<int>(value + 0.5f), 0, 2);
            break;
        case homecrate_grainParameterAddress::glueAmount: mGlueAmount = value; break;

        case homecrate_grainParameterAddress::catchCC:     mCatchCCNum  = value; break;
        case homecrate_grainParameterAddress::freezeCC:    mFreezeCCNum = value; break;
        case homecrate_grainParameterAddress::oscillateCC: mOscCCNum    = value; break;

        case homecrate_grainParameterAddress::resMix:      mResMix    = value; break;
        case homecrate_grainParameterAddress::resQ:        mResQ      = value; break;
        case homecrate_grainParameterAddress::resRotate:   mResRotate = value; break;
        case homecrate_grainParameterAddress::resSpread:   mResSpread = value; break;
        case homecrate_grainParameterAddress::keyMask:
            // At least one enabled key — the ring must never be empty.
            mKeyMask = std::clamp(static_cast<int>(value + 0.5f), 1, 0x0FFF);
            break;
        case homecrate_grainParameterAddress::resRoot:
            mResRoot = std::clamp(value, 24.f, 72.f);
            break;
        case homecrate_grainParameterAddress::resMorph:    mResMorph = value; break;
        case homecrate_grainParameterAddress::resBandMask:
            mResBandMask = std::clamp(static_cast<int>(value + 0.5f), 1, 63);
            break;
        case homecrate_grainParameterAddress::resSend:
            mResSend = std::clamp(static_cast<int>(value + 0.5f), 0, 2);
            break;

        case homecrate_grainParameterAddress::resLfoTarget:
            mResLfoTarget = std::clamp(static_cast<int>(value + 0.5f), 0, 6);
            break;
        case homecrate_grainParameterAddress::resLfoRate:
            mResLfoRate = std::clamp(value, 0.05f, 8.f);
            break;
        case homecrate_grainParameterAddress::resLfoSync:
            mResLfoSync = (value >= 0.5f);
            break;
        case homecrate_grainParameterAddress::resLfoDivision:
            mResLfoDivision = std::clamp(static_cast<int>(value + 0.5f), 0, 6);
            break;
        case homecrate_grainParameterAddress::resLfoShape:
            mResLfoShape = std::clamp(static_cast<int>(value + 0.5f), 0, 5);
            break;
        case homecrate_grainParameterAddress::resLfoDepth:
            mResLfoDepth = value;
            break;
        case homecrate_grainParameterAddress::grainLfoTarget:
            mGrainLfoTarget = std::clamp(static_cast<int>(value + 0.5f), 0, 7);
            break;
        case homecrate_grainParameterAddress::grainLfoRate:
            mGrainLfoRate = std::clamp(value, 0.05f, 8.f);
            break;
        case homecrate_grainParameterAddress::grainLfoSync:
            mGrainLfoSync = (value >= 0.5f);
            break;
        case homecrate_grainParameterAddress::grainLfoDivision:
            mGrainLfoDivision = std::clamp(static_cast<int>(value + 0.5f), 0, 6);
            break;
        case homecrate_grainParameterAddress::grainLfoShape:
            mGrainLfoShape = std::clamp(static_cast<int>(value + 0.5f), 0, 5);
            break;
        case homecrate_grainParameterAddress::grainLfoDepth:
            mGrainLfoDepth = value;
            break;

        default: break;
    }
}

AUValue homecrate_grainDSPKernel::getParameter(AUParameterAddress address) {
    switch (address) {
        case homecrate_grainParameterAddress::inputGain:       return mInputGain;
        case homecrate_grainParameterAddress::outputGain:      return mOutputGain;
        case homecrate_grainParameterAddress::driveAmount:     return mDriveAmount;
        case homecrate_grainParameterAddress::dryLevel:        return mDryLevel;
        case homecrate_grainParameterAddress::captureMode:     return static_cast<AUValue>(mCaptureMode);
        case homecrate_grainParameterAddress::catchTrigger:    return mCatchParamOn ? 1.f : 0.f;
        case homecrate_grainParameterAddress::freezeHold:      return mFreezeHold ? 1.f : 0.f;
        case homecrate_grainParameterAddress::loopLength:      return mLoopLength;
        case homecrate_grainParameterAddress::loopSync:        return mLoopSync ? 1.f : 0.f;
        case homecrate_grainParameterAddress::loopDivision:    return static_cast<AUValue>(mLoopDivision);
        case homecrate_grainParameterAddress::loopOverdub:     return mLoopOverdub ? 1.f : 0.f;
        case homecrate_grainParameterAddress::loopFade:        return mLoopFade;
        case homecrate_grainParameterAddress::captureSource:   return static_cast<AUValue>(mCaptureSource);
        case homecrate_grainParameterAddress::grainMix:        return mGrainMix;
        case homecrate_grainParameterAddress::grainSize:       return mGrainSize;
        case homecrate_grainParameterAddress::grainDensity:    return mGrainDensity;
        case homecrate_grainParameterAddress::grainSpray:      return mGrainSpray;
        case homecrate_grainParameterAddress::grainPitch:      return mGrainPitch;
        case homecrate_grainParameterAddress::grainPitchQuant: return mGrainPitchQuant ? 1.f : 0.f;
        case homecrate_grainParameterAddress::grainPitchRand:  return mGrainPitchRand;
        case homecrate_grainParameterAddress::grainReverse:    return mGrainReverse;
        case homecrate_grainParameterAddress::grainSpread:     return mGrainSpread;
        case homecrate_grainParameterAddress::grainShape:      return static_cast<AUValue>(mGrainShape);
        case homecrate_grainParameterAddress::grainFeedback:   return mGrainFeedback;
        case homecrate_grainParameterAddress::grainScan:       return mGrainScan;
        case homecrate_grainParameterAddress::grainClock:      return static_cast<AUValue>(mGrainClock);
        case homecrate_grainParameterAddress::crossTarget:     return static_cast<AUValue>(mCrossTarget);
        case homecrate_grainParameterAddress::crossAmount:     return mCrossAmount;
        case homecrate_grainParameterAddress::grainTone:       return mGrainTone;
        case homecrate_grainParameterAddress::midiMode:        return static_cast<AUValue>(mMidiMode);
        case homecrate_grainParameterAddress::midiRoot:        return mMidiRoot;
        case homecrate_grainParameterAddress::midiAttack:      return mMidiAttack;
        case homecrate_grainParameterAddress::midiRelease:     return mMidiRelease;
        case homecrate_grainParameterAddress::delayTime:       return mDelayTime;
        case homecrate_grainParameterAddress::delayFeedback:   return mDelayFeedback;
        case homecrate_grainParameterAddress::delayTone:       return mDelayTone;
        case homecrate_grainParameterAddress::delayLevel:      return mDelayLevel;
        case homecrate_grainParameterAddress::delaySync:       return mDelaySync ? 1.f : 0.f;
        case homecrate_grainParameterAddress::delayDivision:   return static_cast<AUValue>(mDelayDivision);
        case homecrate_grainParameterAddress::delayPingPong:   return mDelayPingPong ? 1.f : 0.f;
        case homecrate_grainParameterAddress::delayTape:       return mDelayTape ? 1.f : 0.f;
        case homecrate_grainParameterAddress::delayDuck:       return mDelayDuck ? 1.f : 0.f;
        case homecrate_grainParameterAddress::delaySend:       return static_cast<AUValue>(mDelaySend);
        case homecrate_grainParameterAddress::delayRoute:      return static_cast<AUValue>(mDelayRoute);
        case homecrate_grainParameterAddress::delayOscillate:  return mDelayOscillate ? 1.f : 0.f;
        case homecrate_grainParameterAddress::reverbDecay:     return mReverbDecay;
        case homecrate_grainParameterAddress::reverbBlend:     return mReverbBlend;
        case homecrate_grainParameterAddress::reverbSize:      return mReverbSize;
        case homecrate_grainParameterAddress::reverbPreDelay:  return mReverbPreDelay;
        case homecrate_grainParameterAddress::reverbTone:      return mReverbTone;
        case homecrate_grainParameterAddress::reverbDryFeed:   return mReverbDryFeed;
        case homecrate_grainParameterAddress::washAmount:      return mWashAmount;
        case homecrate_grainParameterAddress::washWarble:      return mWashWarble;
        case homecrate_grainParameterAddress::washMode:        return static_cast<AUValue>(mWashMode);
        case homecrate_grainParameterAddress::glueAmount:      return mGlueAmount;
        case homecrate_grainParameterAddress::catchCC:         return mCatchCCNum;
        case homecrate_grainParameterAddress::freezeCC:        return mFreezeCCNum;
        case homecrate_grainParameterAddress::oscillateCC:     return mOscCCNum;
        case homecrate_grainParameterAddress::resMix:          return mResMix;
        case homecrate_grainParameterAddress::resQ:            return mResQ;
        case homecrate_grainParameterAddress::resRotate:       return mResRotate;
        case homecrate_grainParameterAddress::resSpread:       return mResSpread;
        case homecrate_grainParameterAddress::keyMask:      return static_cast<AUValue>(mKeyMask);
        case homecrate_grainParameterAddress::resRoot:         return mResRoot;
        case homecrate_grainParameterAddress::resMorph:        return mResMorph;
        case homecrate_grainParameterAddress::resBandMask:     return static_cast<AUValue>(mResBandMask);
        case homecrate_grainParameterAddress::resSend:         return static_cast<AUValue>(mResSend);
        case homecrate_grainParameterAddress::resLfoTarget:    return static_cast<AUValue>(mResLfoTarget);
        case homecrate_grainParameterAddress::resLfoRate:      return mResLfoRate;
        case homecrate_grainParameterAddress::resLfoSync:      return mResLfoSync ? 1.f : 0.f;
        case homecrate_grainParameterAddress::resLfoDivision:  return static_cast<AUValue>(mResLfoDivision);
        case homecrate_grainParameterAddress::resLfoShape:     return static_cast<AUValue>(mResLfoShape);
        case homecrate_grainParameterAddress::resLfoDepth:     return mResLfoDepth;
        case homecrate_grainParameterAddress::grainLfoTarget:  return static_cast<AUValue>(mGrainLfoTarget);
        case homecrate_grainParameterAddress::grainLfoRate:    return mGrainLfoRate;
        case homecrate_grainParameterAddress::grainLfoSync:    return mGrainLfoSync ? 1.f : 0.f;
        case homecrate_grainParameterAddress::grainLfoDivision: return static_cast<AUValue>(mGrainLfoDivision);
        case homecrate_grainParameterAddress::grainLfoShape:   return static_cast<AUValue>(mGrainLfoShape);
        case homecrate_grainParameterAddress::grainLfoDepth:   return mGrainLfoDepth;
        default: return 0.f;
    }
}

// ── Max frames ────────────────────────────────────────────────────────────────

AUAudioFrameCount homecrate_grainDSPKernel::maximumFramesToRender() const {
    return mMaxFramesToRender;
}

void homecrate_grainDSPKernel::setMaximumFramesToRender(const AUAudioFrameCount& maxFrames) {
    mMaxFramesToRender = maxFrames;
    const size_t frames = maxFrames;
    mDryL.assign(frames, 0.f);      mDryR.assign(frames, 0.f);
    mGrainBusL.assign(frames, 0.f); mGrainBusR.assign(frames, 0.f);
    mSendL.assign(frames, 0.f);     mSendR.assign(frames, 0.f);
    mWetL.assign(frames, 0.f);      mWetR.assign(frames, 0.f);
    mVerbL.assign(frames, 0.f);     mVerbR.assign(frames, 0.f);
    mRingSrcL.assign(frames, 0.f);  mRingSrcR.assign(frames, 0.f);
}

// ── Host tempo ────────────────────────────────────────────────────────────────

void homecrate_grainDSPKernel::setHostBPM(double bpm) {
    mHostBPM.store(bpm > 0.0 ? bpm : 0.0, std::memory_order_relaxed);
}

// ── Process (real-time thread) ────────────────────────────────────────────────

void homecrate_grainDSPKernel::process(const float* const* inputBuffers,  int numInputs,
                                       float* const*       outputBuffers, int numOutputs,
                                       AUEventSampleTime   bufferStartTime,
                                       AUAudioFrameCount   frameCount)
{
    const int n = static_cast<int>(frameCount);
    // NO os_log anywhere in this function: it is not RT-safe and periodic
    // flavors were audible as metronomic pops at 3 ms buffers (suite history).
    const uint64_t kPerfT0 = hcNowNs();

    if (mBypassed) {
        for (int ch = 0; ch < numInputs && ch < numOutputs; ++ch)
            std::copy_n(inputBuffers[ch], n, outputBuffers[ch]);
        return;
    }

    if (!mLock.try_lock()) {
        for (int ch = 0; ch < numInputs && ch < numOutputs; ++ch)
            std::copy_n(inputBuffers[ch], n, outputBuffers[ch]);
        return;
    }

    const float inGain  = mInputGain;
    const float outGain = mOutputGain;

    const float* inL = (numInputs > 0 && inputBuffers[0]) ? inputBuffers[0] : nullptr;
    if (!inL || n > static_cast<int>(mDryL.size()) || !mGrain || !mDelay || !mReverb) {
        for (int ch = 0; ch < numOutputs; ++ch)
            if (outputBuffers[ch]) std::fill_n(outputBuffers[ch], n, 0.f);
        mLock.unlock();
        return;
    }
    const float* inR = (numInputs > 1 && inputBuffers[1]) ? inputBuffers[1] : inL;

    // Per-block refresh seams.
    if (mReverbDirty.exchange(false, std::memory_order_acq_rel))
        refreshReverb();
    refreshDelay();     // dirty params + BPM sync + momentary oscillate
    refreshWash();      // activity/edge decision (reset-on-edge, lofi precedent)
    resolveLoopLen();   // catch span: free seconds vs. beat-sync BPM poll

    // ── Assignable LFOs (block-rate; grain LFO applies at spawn time) ─────────
    const float resLfoV = tickLfo(mResLfoPhase, mResLfoSH, mResLfoRng,
                                  mResLfoTarget, mResLfoShape, mResLfoDepth,
                                  mResLfoSync, mResLfoDivision, mResLfoRate, n);
    const float grainLfoV = tickLfo(mGrainLfoPhase, mGrainLfoSH, mGrainLfoRng,
                                    mGrainLfoTarget, mGrainLfoShape, mGrainLfoDepth,
                                    mGrainLfoSync, mGrainLfoDivision, mGrainLfoRate, n);
    // The MIX target must feed the activity gate below, or an LFO swelling
    // the resonator from base 0 would modulate a skipped section.
    const float resMixEff = (mResLfoTarget == 5)
        ? std::clamp(mResMix + resLfoV, 0.f, 1.f) : mResMix;

    // ── Section activity (perf pass) ──────────────────────────────────────────
    // Inactive feedback engines are DRAINED with silence until their tails
    // die, reset once, then skipped — never gated with content circulating
    // (the documented "massive pop" bug), never burning CPU at idle either.
    // The grain engine is skipped when nothing consumes its bus (it holds no
    // feedback energy, so resuming just spawns fresh grains).
    const bool delayActive = mDelayLevel > 0.0005f || mDelayRoute == 2 || mDelayOscillate;
    const bool verbActive  = mReverbBlend > 0.0005f;
    const bool resoActive  = resMixEff > 0.0005f;
    const bool grainConsumed = mGrainMix > 0.0005f
                            || mGrainFeedback > 0.001f
                            || (delayActive && mDelaySend != 0)
                            || (resoActive && mResSend != 0);

    float* dryL = mDryL.data();
    float* dryR = mDryR.data();

    // ── Input gain → DC BLOCK → DRIVE (dry untouched past this point) ─────────
    // The ~4 Hz DC blocker sits BEFORE drive (tanh on a biased signal makes
    // more DC): upstream NAM amps emit offset that the reverb/delay feedback
    // loops integrate ×20–33 and grains stack — rail-pinned inaudible output,
    // red VU, ring/LCD full (device report 2026-07-31).
    {
        const float R = 0.9995f;
        for (int f = 0; f < n; ++f) {
            const float l  = inL[f] * inGain;
            const float r  = inR[f] * inGain;
            const float yl = l - mDcX1L + R * mDcY1L;
            const float yr = r - mDcX1R + R * mDcY1R;
            mDcX1L = l; mDcY1L = yl;
            mDcX1R = r; mDcY1R = yr;
            dryL[f] = yl;
            dryR[f] = yr;
        }
    }
    if (mDriveAmount > 0.001f) {
        const float pre    = 1.f + 9.f * mDriveAmount;
        const float comp   = 0.25f / std::tanh(pre * 0.25f);
        const float wetAmt = std::min(1.f, mDriveAmount * 1.5f);
        for (int f = 0; f < n; ++f) {
            const float l = dryL[f];
            const float r = dryR[f];
            dryL[f] = l + wetAmt * (std::tanh(pre * l) * comp - l);
            dryR[f] = r + wetAmt * (std::tanh(pre * r) * comp - r);
        }
    }

    // Stage scrubber #1: garbage input must never reach the capture ring —
    // a NaN written into an 8 s ring haunts every grain for 8 seconds.
    // Threshold 64: a GARBAGE detector (NaN fails any comparison; runaway is
    // orders of magnitude), never a level police — legit dense grain stacks
    // peaked past the old 8.0 and each trip WIPED THE RING (post-stereo
    // faint-output bug). The output stage clamps ±1.5 regardless.
    {
        const float mL = hcMaxMag(dryL, n);
        const float mR = hcMaxMag(dryR, n);
        if (!(std::max(mL, mR) <= 64.f)) {
            std::fill_n(dryL, n, 0.f);
            std::fill_n(dryR, n, 0.f);
            mScrubIn.fetch_add(1, std::memory_order_relaxed);
        }
    }

    // ── CROSS follower: instant attack / 200 ms release on the dry level ─────
    for (int f = 0; f < n; ++f) {
        const float a = std::max(std::abs(dryL[f]), std::abs(dryR[f]));
        if (a > mCrossEnv) mCrossEnv = a;
        else               mCrossEnv += mCrossRelease * (a - mCrossEnv);
    }
    mInputLevel.store(std::min(1.f, mCrossEnv), std::memory_order_relaxed);

    // ── Grain engine params: mirrors + CLOCK macro + CROSS spawn modulation ───
    GrainEngine::Params gp;
    gp.captureMode  = mCaptureMode;
    gp.freezeHold   = mFreezeHold;
    gp.overdub      = mLoopOverdub;
    gp.loopFade     = mLoopFade;
    gp.sizeMs       = mGrainSize;
    gp.densityHz    = mGrainDensity;
    gp.spray        = mGrainSpray;
    gp.pitchSemis   = mGrainPitch;
    gp.pitchQuant   = mGrainPitchQuant;
    gp.pitchRand    = mGrainPitchRand;
    gp.reverseProb  = mGrainReverse;
    gp.spread       = mGrainSpread;
    gp.shape        = mGrainShape;
    gp.scan         = mGrainScan;
    gp.clockRatio   = kClockRatios[std::clamp(mGrainClock, 0, 3)];
    gp.zeroOrderHold = (mGrainClock >= 1);

    // Global key: the chassis keybed feeds the quantizer and both MIDI modes.
    gp.keyMask = mKeyMask;
    gp.keyRoot = mMidiRoot;

    // MIDI modes. Notes on disabled keys quantize UP at use-time, so editing
    // the keybed re-tunes held notes live. Root: the latched note re-roots
    // the whole cloud. Play: held notes gate + pitch the grains.
    if (mMidiMode == 2 && mLatchedNote >= 0) {
        const int q = quantizeNoteUp(mLatchedNote, mKeyMask);
        gp.pitchOffsetSemis = std::clamp(static_cast<float>(q) - mMidiRoot, -48.f, 48.f);
    } else if (mMidiMode == 1) {
        // Advance each slot's attack/release envelope (block-rate one-pole)
        // and hand the surviving notes to the engine — released notes keep
        // spawning grains at decaying level until their tail dies.
        const float blockMs = 1000.f * static_cast<float>(n) / static_cast<float>(mSampleRate);
        const float aCoef = 1.f - std::exp(-blockMs / std::max(mMidiAttack, 1.f));
        const float rCoef = 1.f - std::exp(-blockMs / std::max(mMidiRelease, 5.f));
        gp.midiPlay = true;
        int count = 0;
        for (auto& s : mNoteSlots) {
            if (!s.active) continue;
            if (s.held) {
                s.env += aCoef * (1.f - s.env);
            } else {
                s.env += rCoef * (0.f - s.env);
                if (s.env < 0.001f) { s.active = false; s.env = 0.f; continue; }
            }
            if (count < 10) {
                const int q = quantizeNoteUp(static_cast<int>(s.note), mKeyMask);
                gp.noteSemis[count] = static_cast<float>(q) - mMidiRoot;
                gp.noteVel[count]   = s.vel;
                gp.noteEnv[count]   = s.env;
                count += 1;
            }
        }
        gp.noteCount = count;
    }

    // Grain LFO — same spawn-time application as CROSS (zipper-free). Pitch
    // lands PRE-quantize, so with QUANT on the wobble walks the enabled keys.
    // Tone is kernel-level and handled at the filter block below.
    float toneEff = mGrainTone;
    if (grainLfoV != 0.f) {
        switch (mGrainLfoTarget) {
            case 1: gp.sizeMs     = std::clamp(gp.sizeMs * (1.f + 0.75f * grainLfoV), 20.f, 500.f); break;
            case 2: gp.densityHz  = std::clamp(gp.densityHz * (1.f + grainLfoV), 2.f, 80.f); break;
            case 3: gp.spray      = std::clamp(gp.spray + grainLfoV, 0.f, 1.f); break;
            case 4: gp.pitchSemis = std::clamp(gp.pitchSemis + 12.f * grainLfoV, -24.f, 24.f); break;
            case 5: gp.spread     = std::clamp(gp.spread + grainLfoV, 0.f, 1.f); break;
            case 6: gp.scan       = std::clamp(gp.scan + 2.f * grainLfoV, -2.f, 2.f); break;
            case 7: toneEff       = std::clamp(mGrainTone + 0.5f * grainLfoV, 0.f, 1.f); break;
            default: break;
        }
    }

    if (mCrossTarget != 0 && mCrossAmount > 0.001f) {
        // Applied at spawn time only (per-grain snapshots) — inherently
        // zipper-free; playing harder scatters/raises/shrinks the texture.
        const float e = std::min(1.f, mCrossEnv * 4.f) * mCrossAmount;
        switch (mCrossTarget) {
            case 1: gp.densityHz  = std::min(80.f, gp.densityHz * (1.f + 3.f * e)); break;
            case 2: gp.pitchSemis = std::clamp(gp.pitchSemis + 12.f * e, -24.f, 24.f); break;
            case 3: gp.sizeMs     = std::max(20.f, gp.sizeMs * (1.f - 0.7f * e)); break;
            case 4: gp.spray      = std::min(1.f, gp.spray + e); break;
            default: break;
        }
    }
    mGrain->mLiveSprayWindow = static_cast<double>(mLoopLenSamples);
    gp.needMono   = mGrainFeedback > 0.001f;
    gp.cleanWrite = (mDelayRoute != 2) && !(mGrainFeedback > 0.001f);

    // ── GRAIN render (reads ring as of the previous block) ────────────────────
    // Skipped entirely when nothing consumes the bus; the bus is zeroed once
    // on the active→idle edge and the voices are put to sleep.
    float* grainL = mGrainBusL.data();
    float* grainR = mGrainBusR.data();
    uint64_t grainNs = 0;
    if (grainConsumed) {
    mGrainWasConsumed = true;
    std::fill_n(grainL, n, 0.f);
    std::fill_n(grainR, n, 0.f);
    const uint64_t tGrain0 = hcNowNs();
    mGrain->renderGrains(grainL, grainR, n, gp);
    grainNs = hcNowNs() - tGrain0;

    // Stage scrubber #2: a poisoned grain bus means the ring itself is bad —
    // reset the engine (clears the ring) rather than let it haunt for 8 s.
    {
        const float mL = hcMaxMag(grainL, n);
        const float mR = hcMaxMag(grainR, n);
        if (!(std::max(mL, mR) <= 64.f)) {
            std::fill_n(grainL, n, 0.f);
            std::fill_n(grainR, n, 0.f);
            mGrain->reset();
            mScrubFx.fetch_add(1, std::memory_order_relaxed);
        }
    }
    } else if (mGrainWasConsumed) {
        mGrainWasConsumed = false;
        mGrain->sleep();
        std::fill_n(grainL, static_cast<size_t>(mGrainBusL.size()), 0.f);
        std::fill_n(grainR, static_cast<size_t>(mGrainBusR.size()), 0.f);
    }

    // ── Grain-bus TONE (pre-send, so delayed/reverbed grains inherit it) ──────
    // 0.5 = neutral (skip). Left of center: one-pole LP sweep 12 kHz → 400 Hz
    // (washed-out darkening). Right of center: one-pole HP sweep 40 Hz → 4 kHz
    // (thin the cloud out from under the instrument).
    if (!grainConsumed) {
        // nothing on the bus — filters idle
    } else if (toneEff < 0.49f) {
        const float t  = std::clamp(toneEff, 0.f, 0.49f) / 0.5f;
        const float fc = 400.f * std::pow(12000.f / 400.f, t);
        const float a  = 1.f - std::exp(-2.f * static_cast<float>(M_PI) * fc
                                        / static_cast<float>(mSampleRate));
        for (int f = 0; f < n; ++f) {
            mToneLpL += a * (grainL[f] - mToneLpL);
            mToneLpR += a * (grainR[f] - mToneLpR);
            grainL[f] = mToneLpL;
            grainR[f] = mToneLpR;
        }
    } else if (toneEff > 0.51f) {
        const float t  = (std::clamp(toneEff, 0.51f, 1.f) - 0.5f) / 0.5f;
        const float fc = 40.f * std::pow(4000.f / 40.f, t);
        const float a  = 1.f - std::exp(-2.f * static_cast<float>(M_PI) * fc
                                        / static_cast<float>(mSampleRate));
        for (int f = 0; f < n; ++f) {
            mToneHpL += a * (grainL[f] - mToneHpL);
            mToneHpR += a * (grainR[f] - mToneHpR);
            grainL[f] -= mToneHpL;
            grainR[f] -= mToneHpR;
        }
    }

    // ── DELAY send bus {Input | Grains | Input+Grains} → 100% wet return ──────
    // Grains are sent RAW (pre-grainMix) so a delay-only texture works even
    // with the grain bus gate closed. When the section is inactive the line
    // is fed SILENCE until its tail drains (feedback ≤ 0.95 → < 6 s), reset
    // once, then skipped — the safe form of the suite's never-gate rule.
    float* sendL = mSendL.data();
    float* sendR = mSendR.data();
    const int64_t kDelayTail = static_cast<int64_t>(6.0 * mSampleRate);
    if (delayActive) {
        mDelayIdleSamples = 0;
        switch (mDelaySend) {
            case 1:
                std::copy_n(grainL, n, sendL);
                std::copy_n(grainR, n, sendR);
                break;
            case 2:
                for (int f = 0; f < n; ++f) { sendL[f] = dryL[f] + grainL[f]; sendR[f] = dryR[f] + grainR[f]; }
                break;
            default:
                std::copy_n(dryL, n, sendL);
                std::copy_n(dryR, n, sendR);
                break;
        }
        mDelay->processStereo(sendL, sendR, n);   // in-place → pure wet (mix pinned 1.0)
    } else if (mDelayIdleSamples < kDelayTail) {
        std::fill_n(sendL, n, 0.f);
        std::fill_n(sendR, n, 0.f);
        mDelay->processStereo(sendL, sendR, n);
        mDelayIdleSamples += n;
        if (mDelayIdleSamples >= kDelayTail) mDelay->reset();
    }
    // else: drained + reset — skipped until the section reactivates.

    // ── Capture-ring source + write pass ──────────────────────────────────────
    // captureSource picks what the ring hears (Bad Mood ROUTING); the grain
    // regeneration tap is ALWAYS added so grainFeedback works at defaults.
    // Route →Ring feeds the delay wet into the ring at a fixed 0.8 so echoes
    // re-emerge as grains (every ring write is tanh-bounded in the engine).
    {
        // Branchless STEREO compose (constants hoisted): fxGain lands the
        // delay→ring route per channel, gmGain the (mono) grain regeneration
        // into both — zero-multiplied when off. No mono sum anywhere: the
        // ring preserves the source's stereo image.
        //
        // regenNorm: ring-injection gains are normalized by expected grain
        // OVERLAP so the ring→grains→ring loop gain is DENSITY-INDEPENDENT.
        // Correlated grain stacks grow by √overlap (the per-grain 1/√overlap
        // assumes uncorrelated grains); without this, cranking DENSITY pushed
        // both regen loops past unity gain → a self-sustaining runaway that
        // climbed in pitch and HELD after density came back down (the
        // "extremely high tone pegging the VU" repro). Loop gain is now
        // bounded by the feedback knobs alone.
        float* srcL = mRingSrcL.data();
        float* srcR = mRingSrcR.data();
        const float* gm = mGrain->grainMono();
        const float overlapEst = std::max(1.f, mGrainDensity * mGrainSize * 0.001f);
        const float regenNorm  = 1.f / std::max(1.f, 0.9f * std::sqrt(overlapEst));
        float fxGain = (mDelayRoute == 2) ? 0.8f : 0.f;
        if (mDelaySend != 0) fxGain *= regenNorm;   // delay wet is grain-derived
        const float gmGain = gp.needMono ? mGrainFeedback * regenNorm : 0.f;
        if (mCaptureSource == 2) {
            for (int f = 0; f < n; ++f) {
                srcL[f] = fxGain * sendL[f] + gmGain * gm[f];
                srcR[f] = fxGain * sendR[f] + gmGain * gm[f];
            }
        } else {
            for (int f = 0; f < n; ++f) {
                srcL[f] = dryL[f] + fxGain * sendL[f] + gmGain * gm[f];
                srcR[f] = dryR[f] + fxGain * sendR[f] + gmGain * gm[f];
            }
        }
        mGrain->writeRing(srcL, srcR, n, gp, mLoopLenSamples);
    }

    // ── Wet bus assembly ──────────────────────────────────────────────────────
    float* wetL = mWetL.data();
    float* wetR = mWetR.data();
    for (int f = 0; f < n; ++f) {
        wetL[f] = grainL[f] * mGrainMix;
        wetR[f] = grainR[f] * mGrainMix;
    }
    if (delayActive && mDelayRoute == 3) {   // →Wash: echoes join BEFORE the wash stage
        for (int f = 0; f < n; ++f) {
            wetL[f] += sendL[f] * mDelayLevel;
            wetR[f] += sendR[f] * mDelayLevel;
        }
    }

    // ── REVERB send/return (blend pinned 1.0; drain-then-skip when unused) ────
    // At blend ≈ 0 the return contributes nothing anyway, so the tanks are
    // fed silence until the tail dies (feedback ≤ 0.97 → < 8 s), reset once,
    // then skipped. Two full FDN tanks at idle were the chain's single
    // biggest fixed cost.
    {
        const int64_t kVerbTail = static_cast<int64_t>(8.0 * mSampleRate);
        float* vL = mVerbL.data();
        float* vR = mVerbR.data();
        if (verbActive) {
            mVerbIdleSamples = 0;
            const float toVerbGain = (delayActive && mDelayRoute == 1) ? mDelayLevel : 0.f;
            for (int f = 0; f < n; ++f) {
                vL[f] = wetL[f] + dryL[f] * mReverbDryFeed + sendL[f] * toVerbGain;
                vR[f] = wetR[f] + dryR[f] * mReverbDryFeed + sendR[f] * toVerbGain;
            }
            mReverb->process(vL, n);
            if (mReverbR) mReverbR->process(vR, n);
            for (int f = 0; f < n; ++f) {
                wetL[f] += vL[f] * mReverbBlend;
                wetR[f] += vR[f] * mReverbBlend;
            }
        } else if (mVerbIdleSamples < kVerbTail) {
            std::fill_n(vL, n, 0.f);
            std::fill_n(vR, n, 0.f);
            mReverb->process(vL, n);
            if (mReverbR) mReverbR->process(vR, n);
            mVerbIdleSamples += n;
            if (mVerbIdleSamples >= kVerbTail) {
                mReverb->reset();
                if (mReverbR) mReverbR->reset();
            }
        }
        // else: drained + reset — skipped until blend returns.
    }

    // ── RESONATOR (SMR-inspired quantized 6-band, send/return) ────────────────
    // Runs after the reverb return and BEFORE the wash, so the wash degrades
    // the resonances too. Input per resSend (pre-fader dry / grains / both,
    // console send semantics); the engine ADDS its mix-scaled output into the
    // wet bus and self-silences when resMix is 0.
    if (mReso) {
        float* rL = mVerbL.data();   // free after the reverb return above
        float* rR = mVerbR.data();
        switch (mResSend) {
            case 0:
                std::copy_n(dryL, n, rL);
                std::copy_n(dryR, n, rR);
                break;
            case 1:
                std::copy_n(grainL, n, rL);
                std::copy_n(grainR, n, rR);
                break;
            default:
                for (int f = 0; f < n; ++f) { rL[f] = dryL[f] + grainL[f]; rR[f] = dryR[f] + grainR[f]; }
                break;
        }
        GrainResonator::Params rp;
        rp.mix      = resMixEff;   // includes the MIX-target LFO (activity-gated above)
        rp.q        = mResQ;
        rp.rotate   = mResRotate;
        rp.spread   = mResSpread;
        rp.morph    = mResMorph;
        rp.keyMask  = mKeyMask;
        rp.rootNote = static_cast<int>(mResRoot + 0.5f);
        rp.bandMask = mResBandMask;
        // Resonator LFO — targets land on the block-rate params; band
        // frequencies still SNAP to the enabled keys (rotate wraps so a
        // full-depth sweep is a continuous quantized spin), and MORPH
        // glides whatever the LFO moves.
        if (resLfoV != 0.f) {
            switch (mResLfoTarget) {
                case 1: { float r = mResRotate + 0.5f * resLfoV; r -= std::floor(r); rp.rotate = r; } break;
                case 2: rp.spread = std::clamp(mResSpread + resLfoV, 0.f, 1.f); break;
                case 3: rp.q      = std::clamp(mResQ + resLfoV, 0.f, 1.f); break;
                case 4: rp.morph  = std::clamp(mResMorph + resLfoV, 0.f, 1.f); break;
                case 6: rp.rootNote = std::clamp(static_cast<int>(mResRoot + 12.f * resLfoV + 0.5f), 24, 72); break;
                default: break;   // 5 (Mix) already folded into resMixEff
            }
        }
        mReso->process(rL, rR, wetL, wetR, n, rp);
    }

    // ── WASH (lofi macro on the whole wet bus; skip when inactive) ────────────
    if (mWashActive && mLofiL && mLofiR) {
        const float a = mWashAmount;
        LofiEngine::Params lp;
        lp.micType     = 0;
        lp.micAmount   = 1.f;
        lp.crush       = std::min(1.f, 0.7f * a + clockCrushFloor(mGrainClock));
        lp.noiseType   = (mWashMode == 2) ? 1 : 0;            // Broken → crackle
        lp.noiseAmount = 0.3f * a;
        lp.warble      = std::min(1.f, mWashWarble + ((mWashMode == 0) ? 0.15f * a : 0.f));
        lp.carrier     = (mWashMode == 1) ? 0.5f * a : 0.f;   // AM Radio
        lp.carrierMode = 0;
        lp.transmit    = (mWashMode == 2) ? std::min(1.f, 0.5f * a + std::max(0.f, a - 0.6f) * 1.5f)
                                          : std::max(0.f, a - 0.6f) * 1.5f;
        lp.mix         = 1.f;
        lp.lfoTarget   = 0;
        lp.lfoDepth    = 0.f;
        LofiEngine::Block lb;   // static wash — grain motion provides the movement
        mLofiL->process(wetL, n, lp, lb);
        mLofiR->process(wetR, n, lp, lb);
    }

    if (delayActive && mDelayRoute == 0) {   // Out: clean echoes over the washed bed
        for (int f = 0; f < n; ++f) {
            wetL[f] += sendL[f] * mDelayLevel;
            wetR[f] += sendR[f] * mDelayLevel;
        }
    }

    // Stage scrubber #3: a trip resets every stateful engine so a poisoned
    // line can't keep screaming (vocal precedent).
    {
        const float mL = hcMaxMag(wetL, n);
        const float mR = hcMaxMag(wetR, n);
        const float mx = std::max(mL, mR);
        if (!(mx <= 64.f)) {
            std::fill_n(wetL, n, 0.f);
            std::fill_n(wetR, n, 0.f);
            mDelay->reset();
            mReverb->reset();
            if (mReverbR) mReverbR->reset();
            if (mLofiL)   mLofiL->reset();
            if (mLofiR)   mLofiR->reset();
            if (mReso)    mReso->reset();
            mGrain->reset();
            mScrubFx.fetch_add(1, std::memory_order_relaxed);
        } else {
            mWetLevel.store(std::min(1.f, mx), std::memory_order_relaxed);
        }
    }

    // ── Sum + GLUE. Wet is additive; dry rides its OWN fader here (and only
    // here — the capture tap and sends upstream are pre-fader), so dryLevel 0
    // = pure texture with the engines still fully fed (Bad Mood DRY KILL).
    // Glue branch hoisted out of the sample loop (perf pass). ─────────────────
    const float dryG = mDryLevel;
    const float glue = mGlueAmount;
    if (glue > 0.001f) {
        const float gluePre  = 1.f + 2.f * glue;
        const float glueComp = 0.5f / std::tanh(gluePre * 0.5f);
        for (int f = 0; f < n; ++f) {
            float l = dryL[f] * dryG + wetL[f];
            float r = dryR[f] * dryG + wetR[f];
            l += glue * (std::tanh(gluePre * l) * glueComp - l);
            r += glue * (std::tanh(gluePre * r) * glueComp - r);
            wetL[f] = l;   // reuse the wet buffers as the output staging pair
            wetR[f] = r;
        }
    } else {
        for (int f = 0; f < n; ++f) {
            wetL[f] = dryL[f] * dryG + wetL[f];
            wetR[f] = dryR[f] * dryG + wetR[f];
        }
    }

    // 0→1 fade-in ramp (anti-crackle at session start) — both channels.
    int fadeRemaining = mFadeInRemaining.load(std::memory_order_relaxed);
    if (fadeRemaining > 0) {
        const float total = static_cast<float>(mFadeInSamples > 0 ? mFadeInSamples : 1);
        for (int f = 0; f < n; ++f) {
            const int remaining = fadeRemaining - f;
            const float gain = remaining > 0
                ? 1.f - (static_cast<float>(remaining) / total)
                : 1.f;
            wetL[f] *= gain;
            wetR[f] *= gain;
        }
        mFadeInRemaining.store(std::max(0, fadeRemaining - n), std::memory_order_relaxed);
    }

    // L → ch0, R → ch1; any further outputs mirror L. Final hard safety clamp
    // at ±1.5 (suite rule: no upstream bug may hand the chain full-scale garbage).
    for (int ch = 0; ch < numOutputs; ++ch) {
        float* out = outputBuffers[ch];
        if (!out) continue;
        const float* src = (ch == 1) ? wetR : wetL;
        for (int f = 0; f < n; ++f)
            out[f] = std::clamp(src[f] * outGain, -1.5f, 1.5f);
    }

    mLock.unlock();

    // ── Perf counters, flushed ~once per second of audio ──────────────────────
    const uint64_t totalNs = hcNowNs() - kPerfT0;
    mPerf.callCount   += 1;
    mPerf.framesAccum += frameCount;
    mPerf.totalNs     += totalNs;
    mPerf.grainNs     += grainNs;
    mPerf.peakTotalNs  = std::max(mPerf.peakTotalNs, totalNs);
    if (mPerf.framesAccum >= static_cast<uint64_t>(mSampleRate)) {
        mPerfAvgNs.store(mPerf.callCount ? mPerf.totalNs / mPerf.callCount : 0,
                         std::memory_order_relaxed);
        mPerfPeakNs.store(mPerf.peakTotalNs, std::memory_order_relaxed);
        mPerf = {};
    }
}

// ── MIDI (fed directly by the VST3 processor) ─────────────────────────────────

void homecrate_grainDSPKernel::handleMIDIControlChange(int cc, bool on) {
    // All-sound-off / all-notes-off, regardless of value — hosts fire these
    // on transport stop, and a stuck PLAY-mode note would drone forever (the
    // CC120/123 stop-sweep lesson from the VST3 ports). 123 releases (notes
    // ring out through the envelope); 120 kills the tails immediately.
    if (cc == 123) {
        for (auto& s : mNoteSlots) s.held = false;
        return;
    }
    if (cc == 120) {
        for (auto& s : mNoteSlots) { s.held = false; s.active = false; s.env = 0.f; }
        return;
    }
    // Plain bool/flag writes on the render thread (vocal precedent).
    if (cc == static_cast<int>(mCatchCCNum + 0.5f)) {
        if (on && mGrain) mGrain->requestCatchToggle();   // pedal tap = catch toggle
    } else if (cc == static_cast<int>(mFreezeCCNum + 0.5f)) {
        mFreezeHold = on;                                 // hold pedal = freeze while down
    } else if (cc == static_cast<int>(mOscCCNum + 0.5f)) {
        mDelayOscillate = on;                             // runaway while down
    }
}

// ── MIDI note modes ───────────────────────────────────────────────────────────
// Render-thread only (MIDI events and process() share the thread).

void homecrate_grainDSPKernel::handleNoteOn(int note, float velocity) {
    if (note < 0 || note > 127) return;
    mLatchedNote = note;   // Root mode: last note wins, held after release

    // Retrigger a slot already sounding this note (env continues from where
    // it is — no click); else take a free slot; else steal the quietest tail.
    NoteSlot* slot = nullptr;
    float lowest = 2.f;
    for (auto& s : mNoteSlots) {
        if (s.active && s.note == note) { slot = &s; break; }
        if (!s.active) { if (lowest > 1.f) { slot = &s; lowest = 1.f; } }
        else if (!s.held && s.env < lowest) { slot = &s; lowest = s.env; }
    }
    if (!slot) slot = &mNoteSlots[0];
    if (!(slot->active && slot->note == note)) slot->env = 0.f;   // fresh attack
    slot->note   = static_cast<uint8_t>(note);
    slot->vel    = velocity;
    slot->held   = true;
    slot->active = true;
}

void homecrate_grainDSPKernel::handleNoteOff(int note) {
    // Release, don't kill: the envelope rings the note out (per-block advance
    // in process() deactivates the slot once the tail dies).
    for (auto& s : mNoteSlots) {
        if (s.active && s.held && s.note == note) { s.held = false; return; }
    }
}

// ── Loop persistence (main/load thread) ───────────────────────────────────────

void homecrate_grainDSPKernel::loadLoopSamples(const float* dataL, const float* dataR, int count) {
    if (!mGrain || !dataL || count <= 0) return;
    mLock.lock();
    mGrain->loadLoop(dataL, dataR, count);
    mLock.unlock();
}

void homecrate_grainDSPKernel::releaseLoop() {
    if (!mGrain) return;
    mLock.lock();
    mGrain->releaseLoop();
    mLock.unlock();
}

int homecrate_grainDSPKernel::copyLoopSamples(float* dstL, float* dstR, int maxCount) {
    if (!mGrain || !dstL || !dstR || maxCount <= 0) return 0;
    mLock.lock();
    const int n = mGrain->copyLoop(dstL, dstR, maxCount);
    mLock.unlock();
    return n;
}

bool homecrate_grainDSPKernel::loopLatched() const {
    return mGrain ? mGrain->latched() : false;
}

uint64_t homecrate_grainDSPKernel::loopGeneration() const {
    return mGrain ? mGrain->loopGeneration() : 0;
}

// ── LCD visualization copy-out (UI thread, lock-free, torn reads OK) ──────────

void homecrate_grainDSPKernel::getGrainDisplayInfo(GrainDisplayInfo* outInfo, int count) const {
    if (!outInfo || count <= 0) return;
    if (!mGrain) {
        for (int i = 0; i < count; ++i) outInfo[i] = GrainDisplayInfo{ 0.f, 0.f, 0.f, 0.f, 0 };
        return;
    }
    const int64_t trailing = static_cast<int64_t>(mLoopLength * mSampleRate);
    float pos[GrainEngine::kMaxGrains], amp[GrainEngine::kMaxGrains];
    float pan[GrainEngine::kMaxGrains], pit[GrainEngine::kMaxGrains];
    int   act[GrainEngine::kMaxGrains];
    const int filled = mGrain->copyGrainDisplay(pos, amp, pan, pit, act,
                                                std::min(count, GrainEngine::kMaxGrains),
                                                trailing);
    for (int i = 0; i < count; ++i) {
        if (i < filled)
            outInfo[i] = GrainDisplayInfo{ pos[i], amp[i], pan[i], pit[i], act[i] };
        else
            outInfo[i] = GrainDisplayInfo{ 0.f, 0.f, 0.f, 0.f, 0 };
    }
}

void homecrate_grainDSPKernel::getBufferDisplayState(GrainBufferDisplayState* outState) const {
    if (!outState) return;
    *outState = GrainBufferDisplayState{};
    if (!mGrain) return;

    const int64_t trailing = static_cast<int64_t>(mLoopLength * mSampleRate);
    mGrain->renderWaveform(outState->waveMinL, outState->waveMaxL,
                           outState->waveMinR, outState->waveMaxR, 128, trailing);

    const bool latched = mGrain->latched();
    const bool frozen  = mFreezeHold || latched;

    outState->writeHead   = latched ? -1.f : 1.f;
    outState->playHead    = frozen ? mGrain->playheadNorm(trailing) : -1.f;
    outState->captureFill = mGrain->captureFill(trailing);
    if (latched) {
        int64_t start = 0, len = 1;
        mGrain->displaySpan(trailing, start, len);
        outState->loopStart  = 0.f;
        outState->loopLength = std::min(1.f, static_cast<float>(len)
                                           / static_cast<float>(5.0 * mSampleRate));
    } else {
        outState->loopStart  = -1.f;
        outState->loopLength = 0.f;
    }
    outState->frozen      = frozen ? 1 : 0;
    outState->mode        = (mCaptureMode == 0) ? 0 : (latched ? 2 : 1);
    outState->overdubbing = (latched && mLoopOverdub) ? 1 : 0;
    outState->inputLevel  = mInputLevel.load(std::memory_order_relaxed);
    outState->wetLevel    = mWetLevel.load(std::memory_order_relaxed);
    outState->clockRatio  = kClockRatios[std::clamp(mGrainClock, 0, 3)];
}

// ── Private helpers ───────────────────────────────────────────────────────────

// Once-per-block delay refresh (vocal clone minus the mix push — the engine's
// internal mix is pinned at 1.0 for the send/return contract and must never
// be touched here). DUCK note: the engine's duckGain follows the SEND bus
// contents (its "dry"), so with delaySend=Grains the repeats duck against the
// grain bed rather than the player — this is intentional, do not "fix" it.
void homecrate_grainDSPKernel::refreshDelay() {
    if (!mDelay) return;
    if (mDelayDirty.exchange(false, std::memory_order_acq_rel)) {
        mDelay->setFeedback(mDelayFeedback);
        mDelay->setToneNorm(mDelayTone);
        mDelay->setPingPong(mDelayPingPong);
        mDelay->setTape(mDelayTape);
        mDelay->setDuck(mDelayDuck);
        if (!mDelaySync)
            mDelay->setTimeMs(mDelayTime);
    }
    if (mDelaySync) {
        const double tempo = mHostBPM.load(std::memory_order_relaxed);
        if (tempo > 0.0) {
            mDelay->updateFromBPM(tempo, mDelayDivision);
        } else {
            mDelay->setTimeMs(mDelayTime);
        }
    }
    mDelay->setOscillate(mDelayOscillate);
}

// Reverb refresh (vocal mapping): TONE 0 → 1500 Hz … 1 → 9000 Hz; DECAY maps
// to tank feedback 0.70…0.97. Blend is pinned at 1.0 — the tanks are a pure
// wet return; the kernel's reverbBlend scales the return in the wet mix.
void homecrate_grainDSPKernel::refreshReverb() {
    if (!mReverb) return;
    const float cutoff   = 1500.0f * std::pow(9000.0f / 1500.0f, mReverbTone);
    const float feedback = 0.70f + (mReverbDecay * 0.27f);
    for (CostelloReverbEngine* r : { mReverb, mReverbR }) {
        if (!r) continue;
        r->setFeedback(feedback);
        r->setCutoff(cutoff);
        r->setSize(mReverbSize);
        r->setPreDelayMs(mReverbPreDelay);
        r->setBlend(1.0f);
    }
}

// Wash activity/edge decision (refreshLofi pattern — unconditional, cheap
// scalar reads). The lofi engines hold no long-feedback energy, so
// reset-on-edge is safe and keeps an inactive wash at exact passthrough cost.
void homecrate_grainDSPKernel::refreshWash() {
    if (!mLofiL || !mLofiR) { mWashActive = false; return; }
    const bool active = mWashAmount > 0.001f
                     || mWashWarble > 0.001f
                     || clockCrushFloor(mGrainClock) > 0.f;
    if ((active && !mWashWasActive) || mWashMode != mWashPrevMode) {
        mLofiL->reset();
        mLofiR->reset();
    }
    mWashPrevMode  = mWashMode;
    mWashWasActive = active;
    mWashActive    = active;
}

// One kernel-owned LFO tick (vocal lofi-LFO pattern): resolve the rate
// (beat-locked through the shared 7-division table when synced), advance the
// phase by the block, redraw S&H via xorshift on wrap (NEVER rand() on the
// render thread), and return the shaped bipolar value × depth. Phase holds
// still while the LFO is off, so re-enabling resumes where it left.
float homecrate_grainDSPKernel::tickLfo(double& phase, float& shValue, uint32_t& rng,
                                        int target, int shape, float depth,
                                        bool sync, int division, float rateHz, int n) {
    if (target == 0 || depth < 0.001f) return 0.f;

    float hz = rateHz;
    if (sync) {
        const double tempo = mHostBPM.load(std::memory_order_relaxed);
        if (tempo > 0.0) {
            static const float kDivisionMultipliers[7] = {
                1.0f, 0.5f, 0.25f, 1.5f, 0.75f, 0.667f, 0.333f
            };
            hz = static_cast<float>(tempo / 60.0)
               / kDivisionMultipliers[std::clamp(division, 0, 6)];
        }
    }
    hz = std::clamp(hz, 0.01f, 30.f);

    phase += static_cast<double>(hz) * n / mSampleRate;
    if (phase >= 1.0) {
        phase -= std::floor(phase);
        rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
        shValue = static_cast<float>(rng >> 8) * (2.0f / 16777216.0f) - 1.0f;
    }

    const float p = static_cast<float>(phase);
    float raw;
    switch (shape) {
        case 1:  raw = 1.f - 4.f * std::abs(p - 0.5f); break;          // TRI
        case 2:  raw = 2.f * p - 1.f; break;                           // SAW UP
        case 3:  raw = 1.f - 2.f * p; break;                           // SAW DN
        case 4:  raw = (p < 0.5f) ? 1.f : -1.f; break;                 // SQUARE
        case 5:  raw = shValue; break;                                 // S&H
        default: raw = std::sin(2.f * static_cast<float>(M_PI) * p);   // SINE
    }
    return raw * depth;
}

// Catch-span resolve: free-running seconds, or beat-quantized via the host
// tempo when loopSync is on (refreshDelay BPM-poll pattern; ms fallback).
void homecrate_grainDSPKernel::resolveLoopLen() {
    double seconds = static_cast<double>(mLoopLength);
    if (mLoopSync) {
        const double tempo = mHostBPM.load(std::memory_order_relaxed);
        if (tempo > 0.0) {
            static const double kBeats[5] = { 0.5, 1.0, 2.0, 4.0, 8.0 };
            seconds = kBeats[std::clamp(mLoopDivision, 0, 4)] * (60.0 / tempo);
        }
    }
    seconds = std::clamp(seconds, 0.05, GrainEngine::kRingSeconds - 0.5);
    mLoopLenSamples = static_cast<int64_t>(seconds * mSampleRate);
}
