//
//  homecrate_ampDSPKernel.h
//  homecrate amp — VST3 port
//
//  Pure-C++ port of the iOS AUv3 amp kernel. Class/file names and member
//  layout match the AUv3 tree so the two stay diffable. Host-integration
//  seams replaced:
//    - AU parameter/frame types   → plain typedefs below
//    - AURenderEvent / MIDI2 UMP  → handleMIDIControlChange() from the
//                                   VST3 processor's mapped CC params
//    - AUHostMusicalContextBlock  → setHostBPM() from ProcessContext
//    - os_unfair_lock             → KernelSpinLock (atomic_flag)
//    - os_log / mach perf timers  → removed
//    - processABL/handleNullPull  → removed (AU render-block plumbing)
//

#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

#include "homecrate_ampParameterAddresses.h"

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

// Forward declarations — full types only needed in the .cpp.
namespace nam { class DSP; }
class IRConvolver;
class CostelloReverbEngine;
class AmpDelayEngine;

class homecrate_ampDSPKernel {
public:

    homecrate_ampDSPKernel() = default;
    ~homecrate_ampDSPKernel();

    homecrate_ampDSPKernel(const homecrate_ampDSPKernel&)            = delete;
    homecrate_ampDSPKernel& operator=(const homecrate_ampDSPKernel&) = delete;

    // MARK: - Lifecycle
    void initialize(int inputChannelCount, int outputChannelCount, double inSampleRate);
    void deInitialize();
    void clearDSPResetStamps();

    // MARK: - Bypass
    bool isBypassed();
    void setBypass(bool shouldBypass);

    // MARK: - File loading  (call from a background thread — NEVER the audio thread;
    // Reset() prewarms the model, ~226 ms)
    bool loadNAMFromPath(const char* path, double sampleRate, int maxFrames);
    // Load an INDEPENDENT right-channel NAM model (unlinked stereo). See the
    // AUv3 kernel for the full contract; unchanged here.
    bool loadNAMRFromPath(const char* path, double sampleRate, int maxFrames);
    void setIRSamples(const float* data, int count, double sampleRate);
    // Independent right-channel cabinet IR (dynamic morph profile B).
    void setIRRSamples(const float* data, int count, double sampleRate);
    void clearNAM();
    void clearNAMR();
    void clearIR();
    void clearIRR();

    // MARK: - Dynamic morph meter (published from the render thread, UI polls)
    float morphPosMeter() const { return mMorphPosMeter.load(std::memory_order_relaxed); }

    // MARK: - Lazy stereo companion  (call from the background load thread)
    bool ensureStereoCompanion();
    void releaseStereoCompanion();

    // MARK: - Parameters
    void setParameter(AUParameterAddress address, AUValue value);
    AUValue getParameter(AUParameterAddress address) const;

    // MARK: - Max frames
    AUAudioFrameCount maximumFramesToRender() const;
    void setMaximumFramesToRender(const AUAudioFrameCount& maxFrames);

    // MARK: - Host tempo (per block from the VST3 ProcessContext)
    void setHostBPM(double bpm);

    // MARK: - Process  (real-time thread)
    // seamOnly: crate's graph already ran pad, inputGain, the tone stack,
    // and outputGain. Skip those stages so a bake does not EQ twice.
    void process(const float* const* inputBuffers,  int numInputs,
                 float* const*       outputBuffers, int numOutputs,
                 AUEventSampleTime   bufferStartTime,
                 AUAudioFrameCount   frameCount,
                 bool                seamOnly = false);

    bool hasNAM() const;

    // MARK: - MIDI (delay runaway-oscillation CC trigger)
    // A CC matching the delayOscCC parameter (on = value >= 64 / 0.5 norm)
    // flips the momentary delayOscillate state. Called on the audio thread.
    void handleMIDIControlChange(int cc, bool on);

    // MARK: - Latency reporting
    // IRConvolver partition latency (512) when an IR is active, else 0.
    // Feeds IAudioProcessor::getLatencySamples.
    int effectiveLatencySamples() const;

    // MARK: - Public members
    double            mSampleRate        = 48000.0;
    bool              mBypassed          = false;
    AUAudioFrameCount mMaxFramesToRender = 4096;

    double            mDSPResetSampleRate  = 0.0;
    int               mDSPResetMaxFrames   = 0;

    // Fade-in ramp length applied when a new model swaps in mid-playback.
    double           mWarmupAmplitude  = 0.08;
    int              mFadeInSamples    = 24000;

private:
    void deleteDSP();
    void deleteIR();
    void recomputeEQCoeffs();
    void applyEQ(float* buf, int n, int ch = 0);
    void computeReverbGateGains(const float* dry, float* gains, int n, int ch = 0);
    void designMorphLowpass();
    float computeMorphTarget(const float* in, int n);

    void stageInput(int ch, const float* in, int n, float inGain, float normIn, bool skipHostStages);
    void stagePreReverb(int ch, int n, bool reverbActive);
    void stageAmp(int ch, int n, float normOut, int fadeStart, bool skipHostStages);
    void stagePostReverb(int ch, int n, bool reverbActive);
    void stageOutput(int ch, float* out, int n, float outGain);

    enum DelaySeam { kDelaySeamA = 0, kDelaySeamB, kDelaySeamC, kDelaySeamD };
    int resolveDelaySeam() const;
    void runDelayStereo(int n, bool clampAfter);
    void refreshDelay();

    static constexpr int kEQBands = 5;

    struct BiquadCoeffs { double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0; };
    struct BiquadState  { double x1 = 0, x2 = 0, y1 = 0, y2 = 0; };

    std::array<float,       kEQBands> mEQGainDB = {};
    std::array<BiquadCoeffs,kEQBands> mEQCoeffs = {};
    std::array<BiquadState, kEQBands> mEQState  = {};
    std::array<BiquadState, kEQBands> mEQStateR = {};
    std::atomic<bool>                 mEQDirty  { true };

    float mReverbDecay = 0.5f;
    float mReverbBlend = 0.0f;
    float mReverbSize = 1.0f;
    float mReverbPreDelay = 0.0f;
    float mReverbTone = 0.7f;
    std::atomic<bool> mReverbDirty { false };

    float mDelayTime      = 350.0f;
    float mDelayFeedback  = 0.35f;
    float mDelayTone      = 0.7f;
    float mDelayMix       = 0.0f;
    bool  mDelaySync      = false;
    int   mDelayDivision  = 1;
    bool  mDelayPingPong  = false;
    bool  mDelayTape      = false;
    bool  mDelayDuck      = false;
    int   mDelayPlacement = 2;
    bool  mDelayOscillate = false;
    float mDelayOscCC     = 27.0f;
    std::atomic<bool> mDelayDirty { true };

    bool mReverbPreAmp = false;
    bool mEQPostAmp    = false;
    bool mStereoMode   = false;
    bool mInputPad     = false;
    bool mInvertR      = false;

    bool  mReverbGated = false;
    float mGateEnv     = 0.f;
    float mGateGain    = 0.f;
    bool  mGateOpen    = false;
    float mGateEnvR    = 0.f;
    float mGateGainR   = 0.f;
    bool  mGateOpenR   = false;

    nam::DSP*              mDSP       = nullptr;
    IRConvolver*           mConvolver = nullptr;
    CostelloReverbEngine*  mReverb    = nullptr;
    nam::DSP*              mDSPR       = nullptr;
    IRConvolver*           mConvolverR = nullptr;
    CostelloReverbEngine*  mReverbR    = nullptr;
    AmpDelayEngine*        mDelay      = nullptr;

    mutable KernelSpinLock mLock;

    float mInputGain  = 1.f;
    float mOutputGain = 1.f;
    bool  mChannelLink   = true;
    bool  mVolLink       = true;
    float mInputGainR    = 1.f;
    float mOutputGainR   = 1.f;

    bool  mIRNormalize = true;
    float mIRNormScale = 1.f;
    float mIRNormScaleR = 1.f;

    // VST3-only: apply the model's input_level_dbu metadata pre-gain.
    // Default OFF — see inputCalibration in the addresses header. The
    // metadata-derived gains are still computed and stored at load; this
    // flag gates their USE, so toggling needs no model reload.
    bool  mInputCal = false;

    float mNormInputGain  = 1.f;
    float mNormOutputGain = 1.f;
    float mNormInputGainR  = 1.f;
    float mNormOutputGainR = 1.f;

    // Dynamic morph
    bool  mMorphEnable      = false;
    int   mMorphSource      = 0;
    float mMorphDepth       = 0.75f;
    float mMorphThreshold   = 0.35f;
    float mMorphSensitivity = 0.5f;
    float mMorphAttack      = 5.f;
    float mMorphRelease     = 120.f;
    bool  mMorphInvert      = false;
    float mMorphManual      = 0.f;
    bool  mMorphTargetAmp   = true;
    bool  mMorphTargetIR    = true;

    float       mMorphEnv     = 0.f;
    float       mMorphBassEnv = 0.f;
    BiquadCoeffs mMorphLPCoeffs;
    BiquadState  mMorphLPState;
    float       mMorphPos     = 0.f;
    std::atomic<float> mMorphPosMeter { 0.f };

    std::atomic<int> mFadeInRemaining  { 0 };
    double mKeepalivePhase = 0.0;

    std::atomic<double> mHostBPM { 0.0 };   // 0 = host reported no tempo

    std::vector<float>  mMonoBuf;
    std::vector<double> mNAMInBuf;
    std::vector<double> mNAMOutBuf;
    std::vector<float>  mGateBuf;
    std::vector<float>  mMonoBufR;
    std::vector<double> mNAMInBufR;
    std::vector<double> mNAMOutBufR;
    std::vector<float>  mGateBufR;
    std::vector<float>  mMorphBufB;
    std::vector<float>  mMorphPosBuf;

    // Loader-side caches (background load thread only).
    std::string        mNAMPathCache;
    std::vector<float> mIRSampleCache;
    std::string        mNAMPathCacheR;
};
