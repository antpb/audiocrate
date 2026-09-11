//
//  homecrate_ampDSPKernel.cpp
//  homecrate amp — VST3 port
//
//  Faithful port of the AUv3 homecrate_ampDSPKernel.mm. DSP behavior is
//  intentionally identical; only the host-integration seams differ (see the
//  header). os_log diagnostics and the mach_time perf counters were removed.
//

#include "homecrate_ampDSPKernel.h"

#include "IRConvolver.h"
#include "CostelloReverbEngine.h"
#include "AmpDelayEngine.h"
#include "NAM/activations.h"
#include "NAM/dsp.h"
#include "NAM/get_dsp.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <filesystem>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ── Lifecycle ─────────────────────────────────────────────────────────────────

homecrate_ampDSPKernel::~homecrate_ampDSPKernel() {
    deleteDSP();          // frees both L and R NAM models
    deleteIR();           // frees both L and R convolvers
    delete mReverb;
    mReverb = nullptr;
    delete mReverbR;
    mReverbR = nullptr;
    delete mDelay;
    mDelay = nullptr;
}

void homecrate_ampDSPKernel::initialize(int inputChannelCount, int outputChannelCount, double inSampleRate) {
    (void)inputChannelCount; (void)outputChannelCount;

    nam::activations::Activation::enable_fast_tanh();

    mSampleRate = inSampleRate;
    mMonoBuf.assign(mMaxFramesToRender, 0.f);
    mNAMInBuf.assign(mMaxFramesToRender, 0.0);
    mNAMOutBuf.assign(mMaxFramesToRender, 0.0);
    mGateBuf.assign(mMaxFramesToRender, 0.f);
    mMonoBufR.assign(mMaxFramesToRender, 0.f);
    mNAMInBufR.assign(mMaxFramesToRender, 0.0);
    mNAMOutBufR.assign(mMaxFramesToRender, 0.0);
    mGateBufR.assign(mMaxFramesToRender, 0.f);
    mMorphBufB.assign(mMaxFramesToRender, 0.f);
    mMorphPosBuf.assign(mMaxFramesToRender, 0.f);

    designMorphLowpass();
    mMorphLPState = {};
    mMorphEnv = 0.f;
    mMorphBassEnv = 0.f;
    mMorphPos = mMorphManual;
    mMorphPosMeter.store(mMorphManual, std::memory_order_relaxed);

    for (auto& s : mEQState)  s = {};
    for (auto& s : mEQStateR) s = {};
    mEQDirty.store(true, std::memory_order_relaxed);

    if (!mReverb) mReverb = new CostelloReverbEngine();
    mReverb->setup(mSampleRate);
    mReverb->setFeedback(0.65f);
    mReverb->setCutoff(7000.0f);
    mReverb->setBlend(mReverbBlend);

    if (!mReverbR) mReverbR = new CostelloReverbEngine();
    mReverbR->setup(mSampleRate);
    mReverbR->setFeedback(0.65f);
    mReverbR->setCutoff(7000.0f);
    mReverbR->setBlend(mReverbBlend);

    if (!mDelay) mDelay = new AmpDelayEngine();
    mDelay->init(mSampleRate);
    mDelayDirty.store(true, std::memory_order_release);

    // Hold the lock for the entire Reset() call — initialize() runs while the
    // audio stream is stopped; the only concurrent writer is the loader thread,
    // which may briefly wait through the prewarm (acceptable). See the AUv3
    // kernel for the use-after-free history behind this.
    mLock.lock();
    if (mDSP) {
        const int  newMaxFr = static_cast<int>(mMaxFramesToRender);
        const bool srMatch  = (mDSPResetSampleRate == mSampleRate);
        const bool frMatch  = (mDSPResetMaxFrames  == newMaxFr);

        if (!srMatch || !frMatch) {
            try {
                mDSP->Reset(mSampleRate, newMaxFr);
                if (mDSPR) mDSPR->Reset(mSampleRate, newMaxFr);
                mDSPResetSampleRate = mSampleRate;
                mDSPResetMaxFrames  = newMaxFr;
            } catch (...) {
                // Fail-soft — model keeps its previous state.
            }
        }
        // Fade-in is armed only by model swaps, not engine start (see AUv3 notes).
        mFadeInRemaining = 0;
    }
    mLock.unlock();
}

void homecrate_ampDSPKernel::deInitialize() {
    // Keep models alive across stop/start cycles so there is no reload delay.
    clearDSPResetStamps();
    if (mDelay) mDelay->reset();
}

void homecrate_ampDSPKernel::clearDSPResetStamps() {
    mDSPResetSampleRate = 0.0;
    mDSPResetMaxFrames  = 0;
}

// ── Bypass ────────────────────────────────────────────────────────────────────

bool homecrate_ampDSPKernel::isBypassed()                { return mBypassed; }
void homecrate_ampDSPKernel::setBypass(bool shouldBypass){ mBypassed = shouldBypass; }

// ── File loading ──────────────────────────────────────────────────────────────

bool homecrate_ampDSPKernel::loadNAMFromPath(const char* path, double sampleRate, int maxFrames) {
    nam::DSP* newDSP = nullptr;
    nam::dspData namConf;
    try {
        auto ptr = nam::get_dsp(std::filesystem::path(path), namConf);
        if (!ptr) return false;
        newDSP = ptr.release();
    } catch (...) {
        delete newDSP;
        return false;
    }

    // Reset (prewarm, ~226 ms) OUTSIDE the lock — newDSP isn't visible yet.
    try {
        newDSP->Reset(sampleRate, maxFrames);
    } catch (...) {
        delete newDSP;
        return false;
    }

    // Input / output normalization from model metadata (see AUv3 notes).
    const double kTargetLoudness = -18.0;
    float normInputGain  = 1.0f;
    float normOutputGain = 1.0f;
    if (newDSP->HasInputLevel())
        normInputGain = static_cast<float>(std::pow(10.0, -newDSP->GetInputLevel() / 20.0));
    if (newDSP->HasLoudness())
        normOutputGain = static_cast<float>(std::pow(10.0, (kTargetLoudness - newDSP->GetLoudness()) / 20.0));

    // Right-channel clone, built only for linked stereo (from the already-parsed
    // config — no second file read).
    nam::DSP* newDSPR = nullptr;
    if (mStereoMode && mChannelLink) {
        try {
            auto ptrR = nam::get_dsp(namConf);
            if (ptrR) {
                newDSPR = ptrR.release();
                newDSPR->Reset(sampleRate, maxFrames);
            }
        } catch (...) {
            delete newDSPR;
            newDSPR = nullptr;
        }
    }

    mNAMPathCache = path;

    const int fadeIn = mFadeInSamples;
    mLock.lock();
    delete mDSP;
    mDSP = newDSP;
    if (mChannelLink) {
        delete mDSPR;
        mDSPR            = newDSPR;   // may be null → stereo falls back to mono
        mNormInputGainR  = normInputGain;
        mNormOutputGainR = normOutputGain;
    }
    mDSPResetSampleRate = sampleRate;
    mDSPResetMaxFrames  = maxFrames;
    mNormInputGain      = normInputGain;
    mNormOutputGain     = normOutputGain;
    mFadeInRemaining    = fadeIn;
    mLock.unlock();
    return true;
}

static void deriveNAMNormGains(nam::DSP* dsp, float& normInputGain, float& normOutputGain) {
    const double kTargetLoudness = -18.0;
    normInputGain  = 1.0f;
    normOutputGain = 1.0f;
    if (dsp->HasInputLevel())
        normInputGain = static_cast<float>(std::pow(10.0, -dsp->GetInputLevel() / 20.0));
    if (dsp->HasLoudness())
        normOutputGain = static_cast<float>(std::pow(10.0, (kTargetLoudness - dsp->GetLoudness()) / 20.0));
}

bool homecrate_ampDSPKernel::loadNAMRFromPath(const char* path, double sampleRate, int maxFrames) {
    nam::DSP* newDSPR = nullptr;
    try {
        auto ptr = nam::get_dsp(std::filesystem::path(path));
        if (!ptr) return false;
        newDSPR = ptr.release();
    } catch (...) {
        delete newDSPR;
        return false;
    }

    try {
        newDSPR->Reset(sampleRate, maxFrames);
    } catch (...) {
        delete newDSPR;
        return false;
    }

    float normInputGainR  = 1.0f;
    float normOutputGainR = 1.0f;
    deriveNAMNormGains(newDSPR, normInputGainR, normOutputGainR);

    const int fadeIn = mFadeInSamples;
    mNAMPathCacheR = path;
    mLock.lock();
    delete mDSPR;
    mDSPR            = newDSPR;
    mNormInputGainR  = normInputGainR;
    mNormOutputGainR = normOutputGainR;
    mFadeInRemaining = fadeIn;
    mLock.unlock();
    return true;
}

void homecrate_ampDSPKernel::clearNAMR() {
    nam::DSP* d = nullptr;
    mLock.lock();
    d = mDSPR;
    mDSPR = nullptr;
    mLock.unlock();
    delete d;                 // heavy free outside the lock
    mNAMPathCacheR.clear();
}

// Single source of truth for the IRConvolver partition size == the IR path's
// inherent latency in samples (see effectiveLatencySamples).
static constexpr int kIRPartitionSize = 512;

void homecrate_ampDSPKernel::setIRSamples(const float* data, int count, double sampleRate) {
    (void)sampleRate;
    // Energy-based normalization scale (see AUv3 notes).
    double sumSq = 0.0;
    for (int i = 0; i < count; ++i)
        sumSq += static_cast<double>(data[i]) * static_cast<double>(data[i]);
    constexpr double kIREnergyTarget = 0.25;
    float normScale = 1.f;
    if (sumSq > 1e-12)
        normScale = static_cast<float>(std::sqrt(kIREnergyTarget / sumSq));

    IRConvolver* conv = new IRConvolver();
    conv->setup(data, count, kIRPartitionSize);

    mIRSampleCache.assign(data, data + count);

    IRConvolver* convR = nullptr;
    if (mStereoMode) {
        convR = new IRConvolver();
        convR->setup(data, count, kIRPartitionSize);
    }

    IRConvolver* dropL = nullptr;
    IRConvolver* dropR = nullptr;
    mLock.lock();
    dropL        = mConvolver;   // replace only the A cab
    mConvolver   = conv;
    mIRNormScale = normScale;
    if (mMorphEnable) {
        dropR = convR;           // defensive; normally null (morph excludes stereo)
    } else {
        dropR        = mConvolverR;
        mConvolverR  = convR;
    }
    mLock.unlock();
    delete dropL;
    delete dropR;
}

void homecrate_ampDSPKernel::setIRRSamples(const float* data, int count, double sampleRate) {
    (void)sampleRate;
    double sumSq = 0.0;
    for (int i = 0; i < count; ++i)
        sumSq += static_cast<double>(data[i]) * static_cast<double>(data[i]);
    constexpr double kIREnergyTarget = 0.25;
    float normScale = 1.f;
    if (sumSq > 1e-12)
        normScale = static_cast<float>(std::sqrt(kIREnergyTarget / sumSq));

    IRConvolver* conv = new IRConvolver();
    conv->setup(data, count, kIRPartitionSize);

    IRConvolver* drop = nullptr;
    mLock.lock();
    drop          = mConvolverR;
    mConvolverR   = conv;
    mIRNormScaleR = normScale;
    mLock.unlock();
    delete drop;
}

int homecrate_ampDSPKernel::effectiveLatencySamples() const {
    // Lock before touching mConvolver — hosts read latency on their own thread
    // while clearIR() may be freeing the convolver (see AUv3 use-after-free note).
    mLock.lock();
    const bool ready = (mConvolver && mConvolver->isReady());
    mLock.unlock();
    return ready ? kIRPartitionSize : 0;
}

void homecrate_ampDSPKernel::clearNAM() {
    mLock.lock();
    deleteDSP();
    mLock.unlock();
}

void homecrate_ampDSPKernel::clearIR() {
    IRConvolver* dropL = nullptr;
    IRConvolver* dropR = nullptr;
    mLock.lock();
    dropL = mConvolver;  mConvolver = nullptr;
    if (!mMorphEnable) { dropR = mConvolverR; mConvolverR = nullptr; }
    mLock.unlock();
    delete dropL;
    delete dropR;
}

void homecrate_ampDSPKernel::clearIRR() {
    IRConvolver* drop = nullptr;
    mLock.lock();
    drop = mConvolverR;  mConvolverR = nullptr;
    mLock.unlock();
    delete drop;
}

// ── Lazy stereo companion ─────────────────────────────────────────────────────

bool homecrate_ampDSPKernel::ensureStereoCompanion() {
    if (!mStereoMode) return false;

    const bool linked = mChannelLink;
    const bool useIndepR = !linked && !mNAMPathCacheR.empty();
    const std::string dspSrcPath = useIndepR ? mNAMPathCacheR : mNAMPathCache;

    mLock.lock();
    const bool needDSP = (!mDSPR) && (useIndepR || mDSP != nullptr) && !dspSrcPath.empty();
    const bool needIR  = (mConvolver && !mConvolverR && !mIRSampleCache.empty());
    const double sr    = mSampleRate;
    const int    maxFr = static_cast<int>(mMaxFramesToRender);
    const float  lNormIn  = mNormInputGain;
    const float  lNormOut = mNormOutputGain;
    mLock.unlock();

    if (!needDSP && !needIR) return true;

    nam::DSP* newDSPR = nullptr;
    float builtNormIn  = lNormIn;
    float builtNormOut = lNormOut;
    if (needDSP) {
        try {
            auto ptrR = nam::get_dsp(std::filesystem::path(dspSrcPath));
            if (ptrR) {
                newDSPR = ptrR.release();
                newDSPR->Reset(sr, maxFr);
                if (useIndepR) deriveNAMNormGains(newDSPR, builtNormIn, builtNormOut);
            }
        } catch (...) {
            delete newDSPR;
            newDSPR = nullptr;
        }
    }

    IRConvolver* convR = nullptr;
    if (needIR) {
        convR = new IRConvolver();
        convR->setup(mIRSampleCache.data(), static_cast<int>(mIRSampleCache.size()), kIRPartitionSize);
    }

    nam::DSP*    dropDSP  = nullptr;
    IRConvolver* dropConv = nullptr;
    mLock.lock();
    if (newDSPR) {
        const bool okToInstall = (useIndepR || mDSP) && !mDSPR;
        if (okToInstall) {
            mDSPR            = newDSPR;
            mNormInputGainR  = builtNormIn;
            mNormOutputGainR = builtNormOut;
        } else {
            dropDSP = newDSPR;
        }
    }
    if (convR) {
        if (mConvolver && !mConvolverR) mConvolverR = convR;
        else                            dropConv = convR;
    }
    const bool dspComplete = useIndepR ? (mDSPR != nullptr) : (!mDSP || mDSPR);
    const bool complete = dspComplete && (!mConvolver || mConvolverR);
    mLock.unlock();
    delete dropDSP;
    delete dropConv;
    return complete;
}

void homecrate_ampDSPKernel::releaseStereoCompanion() {
    nam::DSP*    d = nullptr;
    IRConvolver* c = nullptr;
    mLock.lock();
    d = mDSPR;       mDSPR       = nullptr;
    c = mConvolverR; mConvolverR = nullptr;
    mLock.unlock();
    delete d;
    delete c;
}

// ── Parameters ────────────────────────────────────────────────────────────────

void homecrate_ampDSPKernel::setParameter(AUParameterAddress address, AUValue value) {
    switch (address) {
        case homecrate_ampParameterAddress::inputGain:  mInputGain  = value; break;
        case homecrate_ampParameterAddress::outputGain: mOutputGain = value; break;
        case homecrate_ampParameterAddress::irNormalize:
            mIRNormalize = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::eqBand0:
        case homecrate_ampParameterAddress::eqBand1:
        case homecrate_ampParameterAddress::eqBand2:
        case homecrate_ampParameterAddress::eqBand3:
        case homecrate_ampParameterAddress::eqBand4: {
            int band = static_cast<int>(address) - static_cast<int>(homecrate_ampParameterAddress::eqBand0);
            mEQGainDB[band] = value;
            mEQDirty.store(true, std::memory_order_release);
            break;
        }
        case homecrate_ampParameterAddress::reverbDecay:
            mReverbDecay = value;
            mReverbDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::reverbSize:
            mReverbSize = value;
            mReverbDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::reverbPreDelay:
            mReverbPreDelay = value;
            mReverbDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::reverbBlend:
            mReverbBlend = value;
            mReverbDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::reverbTone:
            mReverbTone = value;
            mReverbDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::reverbPreAmp:
            mReverbPreAmp = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::eqPostAmp:
            mEQPostAmp = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::reverbGate: {
            const bool on = (value >= 0.5f);
            if (on && !mReverbGated) {
                mGateEnv  = 0.f;
                mGateGain = 0.f;
                mGateOpen = false;
                mGateEnvR  = 0.f;
                mGateGainR = 0.f;
                mGateOpenR = false;
            }
            mReverbGated = on;
            break;
        }
        case homecrate_ampParameterAddress::stereoMode:
            mStereoMode = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::inputPad:
            mInputPad = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::invertR:
            mInvertR = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::channelLink: {
            const bool on = (value >= 0.5f);
            if (!on && mChannelLink) {
                mNormInputGainR  = mNormInputGain;
                mNormOutputGainR = mNormOutputGain;
            }
            mChannelLink = on;
            break;
        }
        case homecrate_ampParameterAddress::inputGainR:
            mInputGainR = value;
            break;
        case homecrate_ampParameterAddress::outputGainR:
            mOutputGainR = value;
            break;
        case homecrate_ampParameterAddress::volLink:
            mVolLink = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::delayTime:
            mDelayTime = value;
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::delayFeedback:
            mDelayFeedback = value;
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::delayTone:
            mDelayTone = value;
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::delayMix:
            mDelayMix = value;
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::delaySync:
            mDelaySync = (value >= 0.5f);
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::delayDivision:
            mDelayDivision = std::clamp(static_cast<int>(value + 0.5f), 0, 6);
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::delayPingPong:
            mDelayPingPong = (value >= 0.5f);
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::delayTape:
            mDelayTape = (value >= 0.5f);
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::delayDuck:
            mDelayDuck = (value >= 0.5f);
            mDelayDirty.store(true, std::memory_order_release);
            break;
        case homecrate_ampParameterAddress::delayPlacement:
            mDelayPlacement = std::clamp(static_cast<int>(value + 0.5f), 0, 2);
            break;
        case homecrate_ampParameterAddress::delayOscillate:
            mDelayOscillate = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::delayOscCC:
            mDelayOscCC = value;
            break;
        case homecrate_ampParameterAddress::morphEnable: {
            const bool on = (value >= 0.5f);
            if (on && !mMorphEnable) {
                mMorphEnv     = 0.f;
                mMorphBassEnv = 0.f;
                mMorphLPState = {};
                mMorphPos     = mMorphManual;
                mMorphPosMeter.store(mMorphManual, std::memory_order_relaxed);
            }
            mMorphEnable = on;
            break;
        }
        case homecrate_ampParameterAddress::morphSource:
            mMorphSource = std::clamp(static_cast<int>(value + 0.5f), 0, 1);
            break;
        case homecrate_ampParameterAddress::morphDepth:
            mMorphDepth = value;
            break;
        case homecrate_ampParameterAddress::morphThreshold:
            mMorphThreshold = value;
            break;
        case homecrate_ampParameterAddress::morphSensitivity:
            mMorphSensitivity = value;
            break;
        case homecrate_ampParameterAddress::morphAttack:
            mMorphAttack = value;
            break;
        case homecrate_ampParameterAddress::morphRelease:
            mMorphRelease = value;
            break;
        case homecrate_ampParameterAddress::morphInvert:
            mMorphInvert = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::morphManual:
            mMorphManual = value;
            break;
        case homecrate_ampParameterAddress::morphTargetAmp:
            mMorphTargetAmp = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::morphTargetIR:
            mMorphTargetIR = (value >= 0.5f);
            break;
        case homecrate_ampParameterAddress::inputCalibration:
            mInputCal = (value >= 0.5f);
            break;
    }
}

AUValue homecrate_ampDSPKernel::getParameter(AUParameterAddress address) const {
    switch (address) {
        case homecrate_ampParameterAddress::inputGain:  return mInputGain;
        case homecrate_ampParameterAddress::outputGain: return mOutputGain;
        case homecrate_ampParameterAddress::irNormalize: return mIRNormalize ? 1.f : 0.f;
        case homecrate_ampParameterAddress::eqBand0:
        case homecrate_ampParameterAddress::eqBand1:
        case homecrate_ampParameterAddress::eqBand2:
        case homecrate_ampParameterAddress::eqBand3:
        case homecrate_ampParameterAddress::eqBand4: {
            int band = static_cast<int>(address) - static_cast<int>(homecrate_ampParameterAddress::eqBand0);
            return mEQGainDB[band];
        }
        case homecrate_ampParameterAddress::reverbDecay: return mReverbDecay;
        case homecrate_ampParameterAddress::reverbSize: return mReverbSize;
        case homecrate_ampParameterAddress::reverbPreDelay: return mReverbPreDelay;
        case homecrate_ampParameterAddress::reverbBlend: return mReverbBlend;
        case homecrate_ampParameterAddress::reverbTone: return mReverbTone;
        case homecrate_ampParameterAddress::reverbPreAmp: return mReverbPreAmp ? 1.f : 0.f;
        case homecrate_ampParameterAddress::eqPostAmp: return mEQPostAmp ? 1.f : 0.f;
        case homecrate_ampParameterAddress::reverbGate: return mReverbGated ? 1.f : 0.f;
        case homecrate_ampParameterAddress::stereoMode: return mStereoMode ? 1.f : 0.f;
        case homecrate_ampParameterAddress::inputPad:   return mInputPad ? 1.f : 0.f;
        case homecrate_ampParameterAddress::invertR:    return mInvertR ? 1.f : 0.f;
        case homecrate_ampParameterAddress::channelLink: return mChannelLink ? 1.f : 0.f;
        case homecrate_ampParameterAddress::inputGainR:  return mInputGainR;
        case homecrate_ampParameterAddress::outputGainR: return mOutputGainR;
        case homecrate_ampParameterAddress::volLink:     return mVolLink ? 1.f : 0.f;
        case homecrate_ampParameterAddress::delayTime:      return mDelayTime;
        case homecrate_ampParameterAddress::delayFeedback:  return mDelayFeedback;
        case homecrate_ampParameterAddress::delayTone:      return mDelayTone;
        case homecrate_ampParameterAddress::delayMix:       return mDelayMix;
        case homecrate_ampParameterAddress::delaySync:      return mDelaySync ? 1.f : 0.f;
        case homecrate_ampParameterAddress::delayDivision:  return static_cast<AUValue>(mDelayDivision);
        case homecrate_ampParameterAddress::delayPingPong:  return mDelayPingPong ? 1.f : 0.f;
        case homecrate_ampParameterAddress::delayTape:      return mDelayTape ? 1.f : 0.f;
        case homecrate_ampParameterAddress::delayDuck:      return mDelayDuck ? 1.f : 0.f;
        case homecrate_ampParameterAddress::delayPlacement: return static_cast<AUValue>(mDelayPlacement);
        case homecrate_ampParameterAddress::delayOscillate: return mDelayOscillate ? 1.f : 0.f;
        case homecrate_ampParameterAddress::delayOscCC:     return mDelayOscCC;
        case homecrate_ampParameterAddress::morphEnable:      return mMorphEnable ? 1.f : 0.f;
        case homecrate_ampParameterAddress::morphSource:      return static_cast<AUValue>(mMorphSource);
        case homecrate_ampParameterAddress::morphDepth:       return mMorphDepth;
        case homecrate_ampParameterAddress::morphThreshold:   return mMorphThreshold;
        case homecrate_ampParameterAddress::morphSensitivity: return mMorphSensitivity;
        case homecrate_ampParameterAddress::morphAttack:      return mMorphAttack;
        case homecrate_ampParameterAddress::morphRelease:     return mMorphRelease;
        case homecrate_ampParameterAddress::morphInvert:      return mMorphInvert ? 1.f : 0.f;
        case homecrate_ampParameterAddress::morphManual:      return mMorphManual;
        case homecrate_ampParameterAddress::morphTargetAmp:   return mMorphTargetAmp ? 1.f : 0.f;
        case homecrate_ampParameterAddress::morphTargetIR:    return mMorphTargetIR ? 1.f : 0.f;
        case homecrate_ampParameterAddress::inputCalibration: return mInputCal ? 1.f : 0.f;
        default: return 0.f;
    }
}

// ── Max frames ────────────────────────────────────────────────────────────────

AUAudioFrameCount homecrate_ampDSPKernel::maximumFramesToRender() const {
    return mMaxFramesToRender;
}

void homecrate_ampDSPKernel::setMaximumFramesToRender(const AUAudioFrameCount& maxFrames) {
    mMaxFramesToRender = maxFrames;
    mMonoBuf.resize(maxFrames, 0.f);
    mNAMInBuf.resize(maxFrames, 0.0);
    mNAMOutBuf.resize(maxFrames, 0.0);
    mGateBuf.resize(maxFrames, 0.f);
    mMonoBufR.resize(maxFrames, 0.f);
    mNAMInBufR.resize(maxFrames, 0.0);
    mNAMOutBufR.resize(maxFrames, 0.0);
    mGateBufR.resize(maxFrames, 0.f);
    mMorphBufB.resize(maxFrames, 0.f);
    mMorphPosBuf.resize(maxFrames, 0.f);
}

// ── Host tempo ────────────────────────────────────────────────────────────────

void homecrate_ampDSPKernel::setHostBPM(double bpm) {
    mHostBPM.store(bpm > 0.0 ? bpm : 0.0, std::memory_order_relaxed);
}

// ── Process  (real-time thread) ───────────────────────────────────────────────

bool homecrate_ampDSPKernel::hasNAM() const {
    if (!mLock.try_lock()) return true;
    const bool loaded = mDSP != nullptr;
    mLock.unlock();
    return loaded;
}

void homecrate_ampDSPKernel::process(const float* const* inputBuffers,  int numInputs,
                                     float* const*       outputBuffers, int numOutputs,
                                     AUEventSampleTime   bufferStartTime,
                                     AUAudioFrameCount   frameCount,
                                     bool                seamOnly)
{
    (void)bufferStartTime;
    const int n = static_cast<int>(frameCount);

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

    const float inGain   = seamOnly ? 1.0f : mInputGain;
    const float outGain  = seamOnly ? 1.0f : mOutputGain;
    // Input calibration OFF (default) ignores the metadata pre-gain — an
    // uncalibrated DAW DI would otherwise be attenuated by the capture's
    // dBu level (-18 dB typical) and starve the model into a gate-like feel.
    const float normIn   = mInputCal ? mNormInputGain : 1.0f;
    const float normOut  = mNormOutputGain;

    const float* monoIn = (numInputs > 0 && inputBuffers[0]) ? inputBuffers[0] : nullptr;
    if (!monoIn) {
        mLock.unlock();
        return;
    }
    const float* monoInR = (numInputs > 1 && inputBuffers[1]) ? inputBuffers[1] : nullptr;

    // Refresh EQ / reverb coefficients once per block if a parameter changed.
    if (mEQDirty.exchange(false, std::memory_order_acq_rel))
        recomputeEQCoeffs();
    if (mReverbDirty.exchange(false, std::memory_order_acq_rel) && mReverb) {
        // TONE 0 → 1500 Hz (dark, damped) … 1 → 9000 Hz (bright, ringing).
        const float tone = mReverbTone;
        const float cutoff = 1500.0f * std::pow(9000.0f / 1500.0f, tone);
        const float feedback = 0.70f + (mReverbDecay * 0.27f);   // 0.70 … 0.97
        mReverb->setFeedback(feedback);
        mReverb->setCutoff(cutoff);
        mReverb->setSize(mReverbSize);
        mReverb->setPreDelayMs(mReverbPreDelay);
        mReverb->setBlend(mReverbBlend);
        if (mReverbR) {
            mReverbR->setFeedback(feedback);
            mReverbR->setCutoff(cutoff);
            mReverbR->setSize(mReverbSize);
            mReverbR->setPreDelayMs(mReverbPreDelay);
            mReverbR->setBlend(mReverbBlend);
        }
    }

    refreshDelay();

    const bool reverbActive = (mReverb && mReverbBlend > 0.001f);
    const bool delayActive  = (mDelay && mDelayMix > 0.001f);
    const int  delaySeam    = resolveDelaySeam();

    // ── Stereo path (see AUv3 notes on symmetry guards) ──────────────────────
    const bool irSymmetric  = (!mConvolver || mConvolverR != nullptr);
    const bool revSymmetric = (!reverbActive || mReverbR != nullptr);
    const bool useStereo = mStereoMode
                        && numInputs  >= 2 && inputBuffers[0]  && inputBuffers[1]
                        && numOutputs >= 2 && outputBuffers[0] && outputBuffers[1]
                        && mDSP && mDSPR
                        && irSymmetric && revSymmetric;

    if (useStereo) {
        const int fadeStart = mFadeInRemaining.load(std::memory_order_relaxed);
        const float inGain1  = mVolLink     ? inGain  : mInputGainR;
        const float outGain1 = mVolLink     ? outGain : mOutputGainR;
        const float normIn1  = mChannelLink ? normIn  : (mInputCal ? mNormInputGainR : 1.0f);
        const float normOut1 = mChannelLink ? normOut : mNormOutputGainR;

        stageInput(0, inputBuffers[0], n, inGain,  normIn,  seamOnly);
        stageInput(1, inputBuffers[1], n, inGain1, normIn1, seamOnly);
        if (delayActive && delaySeam == kDelaySeamA) runDelayStereo(n, true);

        stagePreReverb(0, n, reverbActive);
        stagePreReverb(1, n, reverbActive);
        if (delayActive && delaySeam == kDelaySeamB) runDelayStereo(n, true);

        stageAmp(0, n, normOut,  fadeStart, seamOnly);
        stageAmp(1, n, normOut1, fadeStart, seamOnly);
        if (delayActive && delaySeam == kDelaySeamC) runDelayStereo(n, false);

        stagePostReverb(0, n, reverbActive);
        stagePostReverb(1, n, reverbActive);
        if (delayActive && delaySeam == kDelaySeamD) runDelayStereo(n, false);

        stageOutput(0, outputBuffers[0], n, outGain);
        stageOutput(1, outputBuffers[1], n, outGain1);
        for (int ch = 2; ch < numOutputs; ++ch)
            if (outputBuffers[ch]) std::copy_n(outputBuffers[0], n, outputBuffers[ch]);
        mFadeInRemaining.store(std::max(0, fadeStart - n), std::memory_order_relaxed);
    } else {

    // ── Mono working buffer ──────────────────────────────────────────────────
    const float  padFactor   = (seamOnly || !mInputPad) ? 1.0f : 0.1f;
    const double totalInGain = static_cast<double>(normIn * inGain * padFactor);
    for (int i = 0; i < n; ++i) {
        const double raw = monoInR ? 0.5 * (static_cast<double>(monoIn[i]) + static_cast<double>(monoInR[i]))
                                   : static_cast<double>(monoIn[i]);
        double s = raw * totalInGain;
        if (s >  1.0) s =  1.0;
        if (s < -1.0) s = -1.0;
        mMonoBuf[i] = static_cast<float>(s);
    }

    // ── Pre-amp EQ (default) ─────────────────────────────────────────────────
    if (!seamOnly && !mEQPostAmp)
        applyEQ(mMonoBuf.data(), n);

    // ── Delay seam A (pre pre-amp-reverb) ────────────────────────────────────
    if (delayActive && delaySeam == kDelaySeamA) {
        mDelay->processMono(mMonoBuf.data(), n);
        for (int i = 0; i < n; ++i) {
            float s = mMonoBuf[i];
            if (s >  1.0f) s =  1.0f;
            if (s < -1.0f) s = -1.0f;
            mMonoBuf[i] = s;
        }
    }

    // ── Pre-amp reverb (optional, with gated-reverb VCA) ─────────────────────
    if (mReverbPreAmp && reverbActive) {
        if (mReverbGated)
            computeReverbGateGains(mMonoBuf.data(), mGateBuf.data(), n);
        mReverb->process(mMonoBuf.data(), n);
        for (int i = 0; i < n; ++i) {
            float s = mReverbGated ? (mMonoBuf[i] * mGateBuf[i]) : mMonoBuf[i];
            if (s >  1.0f) s =  1.0f;
            if (s < -1.0f) s = -1.0f;
            mMonoBuf[i] = s;
        }
    }

    // ── Delay seam B (post pre-amp-reverb, pre NAM) ──────────────────────────
    if (delayActive && delaySeam == kDelaySeamB) {
        mDelay->processMono(mMonoBuf.data(), n);
        for (int i = 0; i < n; ++i) {
            float s = mMonoBuf[i];
            if (s >  1.0f) s =  1.0f;
            if (s < -1.0f) s = -1.0f;
            mMonoBuf[i] = s;
        }
    }

    // ── Dynamic morph gate ───────────────────────────────────────────────────
    const bool morphActive = mMorphEnable && (mDSP != nullptr) && (mDSPR != nullptr);
    float morphTarget = mMorphPos;
    if (morphActive)
        morphTarget = computeMorphTarget(mMonoBuf.data(), n);

    if (mDSP && !morphActive) {
        for (int i = 0; i < n; ++i)
            mNAMInBuf[i] = static_cast<NAM_SAMPLE>(mMonoBuf[i]);

        NAM_SAMPLE* inPtr  = mNAMInBuf.data();
        NAM_SAMPLE* outPtr = mNAMOutBuf.data();

        try {
            mDSP->process(&inPtr, &outPtr, n);
        } catch (...) {
            for (int i = 0; i < n; ++i) mNAMOutBuf[i] = mNAMInBuf[i];
        }

        for (int i = 0; i < n; ++i) {
            float s = static_cast<float>(mNAMOutBuf[i]);
            // Output normalization applied here so mMonoBuf holds level-corrected
            // samples before the IR convolver and user output gain.
            mMonoBuf[i] = std::isfinite(s) ? (s * normOut) : 0.f;
        }
    }
    // else: no NAM loaded — the gained dry signal passes through.

    // ── Fade-in after model swap ─────────────────────────────────────────────
    if (!morphActive) {
        int fadeLeft = mFadeInRemaining.load(std::memory_order_relaxed);
        if (fadeLeft > 0) {
            const float invTotal = 1.0f / static_cast<float>(mFadeInSamples > 0 ? mFadeInSamples : 1);
            for (int i = 0; i < n && fadeLeft > 0; ++i) {
                const float ramp = 1.0f - static_cast<float>(fadeLeft) * invTotal;
                mMonoBuf[i] *= ramp;
                --fadeLeft;
            }
            mFadeInRemaining.store(fadeLeft, std::memory_order_relaxed);
        }
    }

    if (mConvolver && mConvolver->isReady() && !morphActive) {
        mConvolver->process(mMonoBuf.data(), mMonoBuf.data(), n);
        if (mIRNormalize) {
            const float s = mIRNormScale;
            for (int i = 0; i < n; ++i) mMonoBuf[i] *= s;
        }
    }

    // ── Dynamic morph: decoupled amp blend + cab blend ───────────────────────
    if (morphActive) {
        const float slew = 1.0f - std::exp(-1.0f / (0.005f * (float)(mSampleRate > 0 ? mSampleRate : 48000.0)));
        for (int i = 0; i < n; ++i) {
            mMorphPos += slew * (morphTarget - mMorphPos);
            mMorphPosBuf[i] = mMorphPos;
        }
        mMorphPosMeter.store(mMorphPos, std::memory_order_relaxed);

        // With calibration off both profiles see the raw signal (ratio 1).
        const float inRatio = (mInputCal && mNormInputGain > 1e-9f)
            ? (mNormInputGainR / mNormInputGain) : 1.0f;
        for (int i = 0; i < n; ++i) {
            mNAMInBuf[i]  = static_cast<NAM_SAMPLE>(mMonoBuf[i]);
            mNAMInBufR[i] = static_cast<NAM_SAMPLE>(mMonoBuf[i] * inRatio);
        }
        {
            NAM_SAMPLE* inA = mNAMInBuf.data();  NAM_SAMPLE* outA = mNAMOutBuf.data();
            try { mDSP->process(&inA, &outA, n); }
            catch (...) { for (int i = 0; i < n; ++i) mNAMOutBuf[i] = mNAMInBuf[i]; }
            NAM_SAMPLE* inB = mNAMInBufR.data(); NAM_SAMPLE* outB = mNAMOutBufR.data();
            try { mDSPR->process(&inB, &outB, n); }
            catch (...) { for (int i = 0; i < n; ++i) mNAMOutBufR[i] = mNAMInBufR[i]; }
        }
        for (int i = 0; i < n; ++i) {
            const float a = std::isfinite((float)mNAMOutBuf[i])  ? (float)mNAMOutBuf[i]  * normOut           : 0.f;
            const float b = std::isfinite((float)mNAMOutBufR[i]) ? (float)mNAMOutBufR[i] * mNormOutputGainR  : 0.f;
            const float mAmp = mMorphTargetAmp ? mMorphPosBuf[i] : 0.f;
            mMonoBuf[i] = a * (1.0f - mAmp) + b * mAmp;
        }

        const bool aCab = (mConvolver  && mConvolver->isReady());
        const bool bCab = (mConvolverR && mConvolverR->isReady());
        if (mMorphTargetIR && aCab && bCab) {
            for (int i = 0; i < n; ++i) mMorphBufB[i] = mMonoBuf[i];
            mConvolver->process(mMonoBuf.data(),  mMonoBuf.data(),  n);
            mConvolverR->process(mMorphBufB.data(), mMorphBufB.data(), n);
            if (mIRNormalize) {
                for (int i = 0; i < n; ++i) { mMonoBuf[i] *= mIRNormScale; mMorphBufB[i] *= mIRNormScaleR; }
            }
            for (int i = 0; i < n; ++i) {
                const float mCab = mMorphPosBuf[i];
                mMonoBuf[i] = mMonoBuf[i] * (1.0f - mCab) + mMorphBufB[i] * mCab;
            }
        } else {
            IRConvolver* c = aCab ? mConvolver : (bCab ? mConvolverR : nullptr);
            const float   cn = aCab ? mIRNormScale : mIRNormScaleR;
            if (c) {
                c->process(mMonoBuf.data(), mMonoBuf.data(), n);
                if (mIRNormalize) { for (int i = 0; i < n; ++i) mMonoBuf[i] *= cn; }
            }
        }

        int fadeLeft = mFadeInRemaining.load(std::memory_order_relaxed);
        if (fadeLeft > 0) {
            const float invTotal = 1.0f / static_cast<float>(mFadeInSamples > 0 ? mFadeInSamples : 1);
            for (int i = 0; i < n && fadeLeft > 0; ++i) {
                const float ramp = 1.0f - static_cast<float>(fadeLeft) * invTotal;
                mMonoBuf[i] *= ramp;
                --fadeLeft;
            }
            mFadeInRemaining.store(fadeLeft, std::memory_order_relaxed);
        }
    }

    // ── Post-amp EQ (optional) ───────────────────────────────────────────────
    if (!seamOnly && mEQPostAmp)
        applyEQ(mMonoBuf.data(), n);

    // ── Delay seam C (post amp/IR/EQ, pre post-amp-reverb) ───────────────────
    if (delayActive && delaySeam == kDelaySeamC)
        mDelay->processMono(mMonoBuf.data(), n);

    // ── Post-amp Costello reverb (default) ───────────────────────────────────
    if (!mReverbPreAmp && reverbActive) {
        mReverb->process(mMonoBuf.data(), n);
    }

    // ── Delay seam D (chain end) — true-stereo repeats over the mono amp ─────
    if (delayActive && delaySeam == kDelaySeamD && numOutputs >= 2) {
        std::copy_n(mMonoBuf.data(), n, mMonoBufR.data());
        runDelayStereo(n, false);
        for (int ch = 0; ch < numOutputs; ++ch) {
            const float* src = (ch == 1) ? mMonoBufR.data() : mMonoBuf.data();
            for (int i = 0; i < n; ++i)
                outputBuffers[ch][i] = src[i] * outGain;
        }
    } else {
        if (delayActive && delaySeam == kDelaySeamD)
            mDelay->processMono(mMonoBuf.data(), n);

        for (int ch = 0; ch < numOutputs; ++ch)
            for (int i = 0; i < n; ++i)
                outputBuffers[ch][i] = mMonoBuf[i] * outGain;
    }

    } // end mono path (else of useStereo)

    mLock.unlock();
}

// ── MIDI CC (delay runaway-oscillation trigger) ───────────────────────────────

void homecrate_ampDSPKernel::handleMIDIControlChange(int cc, bool on) {
    const int oscCC = static_cast<int>(mDelayOscCC + 0.5f);
    if (cc == oscCC)
        mDelayOscillate = on;
}

// ── Private helpers ───────────────────────────────────────────────────────────

void homecrate_ampDSPKernel::deleteDSP() {
    delete mDSP;
    mDSP = nullptr;
    delete mDSPR;
    mDSPR = nullptr;
    mDSPResetSampleRate = 0.0;
    mDSPResetMaxFrames  = 0;
}
void homecrate_ampDSPKernel::deleteIR()  {
    delete mConvolver;  mConvolver  = nullptr;
    delete mConvolverR; mConvolverR = nullptr;
}

// ── EQ coefficient calculation (Audio EQ Cookbook) ───────────────────────────
//
// Band layout (5 bands):
//   0 — Low Shelf @ 80 Hz, 1 — Peak @ 250 Hz, 2 — Peak @ 800 Hz,
//   3 — Peak @ 3200 Hz, 4 — High Shelf @ 8000 Hz
void homecrate_ampDSPKernel::recomputeEQCoeffs() {
    static const double kFreqs[kEQBands] = { 80.0, 250.0, 800.0, 3200.0, 8000.0 };
    static const double kQ              = 0.707;

    const double fs = mSampleRate > 0.0 ? mSampleRate : 48000.0;

    for (int band = 0; band < kEQBands; ++band) {
        const double dB  = static_cast<double>(mEQGainDB[band]);
        const double fc  = kFreqs[band];
        const double A   = std::pow(10.0, dB / 40.0);
        const double w0  = 2.0 * M_PI * fc / fs;
        const double cosw = std::cos(w0);
        const double sinw = std::sin(w0);

        auto& c = mEQCoeffs[band];

        if (dB == 0.0) {
            c = { 1.0, 0.0, 0.0, 0.0, 0.0 };
            continue;
        }

        if (band == 0) {
            const double alpha = sinw / 2.0 * std::sqrt((A + 1.0 / A) * (1.0 / kQ - 1.0) + 2.0);
            const double sqA   = std::sqrt(A);
            const double a0    = (A + 1) + (A - 1) * cosw + 2 * sqA * alpha;
            c.b0 =  A * ((A + 1) - (A - 1) * cosw + 2 * sqA * alpha) / a0;
            c.b1 =  2 * A * ((A - 1) - (A + 1) * cosw) / a0;
            c.b2 =  A * ((A + 1) - (A - 1) * cosw - 2 * sqA * alpha) / a0;
            c.a1 = -2 * ((A - 1) + (A + 1) * cosw) / a0;
            c.a2 =  ((A + 1) + (A - 1) * cosw - 2 * sqA * alpha) / a0;
        } else if (band == kEQBands - 1) {
            const double alpha = sinw / 2.0 * std::sqrt((A + 1.0 / A) * (1.0 / kQ - 1.0) + 2.0);
            const double sqA   = std::sqrt(A);
            const double a0    = (A + 1) - (A - 1) * cosw + 2 * sqA * alpha;
            c.b0 =  A * ((A + 1) + (A - 1) * cosw + 2 * sqA * alpha) / a0;
            c.b1 = -2 * A * ((A - 1) + (A + 1) * cosw) / a0;
            c.b2 =  A * ((A + 1) + (A - 1) * cosw - 2 * sqA * alpha) / a0;
            c.a1 =  2 * ((A - 1) - (A + 1) * cosw) / a0;
            c.a2 =  ((A + 1) - (A - 1) * cosw - 2 * sqA * alpha) / a0;
        } else {
            const double alpha = sinw * std::sinh(std::log(2.0) / 2.0 * kQ * w0 / sinw);
            const double a0    = 1.0 + alpha / A;
            c.b0 =  (1.0 + alpha * A) / a0;
            c.b1 = -(2.0 * cosw) / a0;
            c.b2 =  (1.0 - alpha * A) / a0;
            c.a1 = -(2.0 * cosw) / a0;
            c.a2 =  (1.0 - alpha / A) / a0;
        }
    }
}

// ── EQ render (5-band biquad cascade, transposed DF-II) ───────────────────────

void homecrate_ampDSPKernel::applyEQ(float* buf, int n, int ch) {
    auto& eqState = (ch == 0) ? mEQState : mEQStateR;
    for (int band = 0; band < kEQBands; ++band) {
        const auto& c = mEQCoeffs[band];
        auto& s = eqState[band];
        for (int i = 0; i < n; ++i) {
            double x = buf[i];
            double y = c.b0 * x + s.x1;
            s.x1 = c.b1 * x - c.a1 * y + s.x2;
            s.x2 = c.b2 * x - c.a2 * y;
            if (y >  1.0) y =  1.0;
            if (y < -1.0) y = -1.0;
            buf[i] = static_cast<float>(y);
        }
    }
}

// ── Gated-reverb VCA key (envelope-follower noise gate) ───────────────────────

void homecrate_ampDSPKernel::computeReverbGateGains(const float* dry, float* gains, int n, int ch) {
    const double fs = mSampleRate > 0.0 ? mSampleRate : 48000.0;

    float& gateEnv  = (ch == 0) ? mGateEnv  : mGateEnvR;
    float& gateGain = (ch == 0) ? mGateGain : mGateGainR;
    bool&  gateOpen = (ch == 0) ? mGateOpen : mGateOpenR;

    auto onePole = [fs](double seconds) -> float {
        const double t = seconds > 1e-6 ? seconds : 1e-6;
        return static_cast<float>(1.0 - std::exp(-1.0 / (t * fs)));
    };

    const float envRel = onePole(0.040);   // 40 ms peak decay
    const float gateAtk = onePole(0.0015); // 1.5 ms
    const float gateRel = onePole(0.070);  // 70 ms
    constexpr float kOpenThresh  = 0.003f;
    constexpr float kCloseThresh = 0.0012f;

    for (int i = 0; i < n; ++i) {
        const float rect = std::fabs(dry[i]);
        if (rect > gateEnv) gateEnv = rect;
        else                gateEnv += envRel * (rect - gateEnv);

        if (gateOpen) { if (gateEnv < kCloseThresh) gateOpen = false; }
        else          { if (gateEnv > kOpenThresh)  gateOpen = true;  }

        const float target = gateOpen ? 1.0f : 0.0f;
        gateGain += (target > gateGain ? gateAtk : gateRel) * (target - gateGain);
        gains[i] = gateGain;
    }
}

// ── Dynamic morph: bass-detector lowpass design (RBJ, ~180 Hz) ───────────────

void homecrate_ampDSPKernel::designMorphLowpass() {
    const double fs   = mSampleRate > 0.0 ? mSampleRate : 48000.0;
    const double fc   = 180.0;
    const double Q    = 0.707;
    const double w0   = 2.0 * M_PI * fc / fs;
    const double cosw = std::cos(w0);
    const double sinw = std::sin(w0);
    const double alpha = sinw / (2.0 * Q);

    const double a0 = 1.0 + alpha;
    auto& c = mMorphLPCoeffs;
    c.b0 = ((1.0 - cosw) / 2.0) / a0;
    c.b1 =  (1.0 - cosw)        / a0;
    c.b2 = ((1.0 - cosw) / 2.0) / a0;
    c.a1 = (-2.0 * cosw)        / a0;
    c.a2 = (1.0 - alpha)        / a0;
}

// ── Dynamic morph: detector → block-target blend position ─────────────────────

float homecrate_ampDSPKernel::computeMorphTarget(const float* in, int n) {
    if (n <= 0) return mMorphPos;
    const double fs = mSampleRate > 0.0 ? mSampleRate : 48000.0;

    auto onePole = [fs](double ms) -> float {
        const double t = (ms > 0.01 ? ms : 0.01) * 0.001;
        return static_cast<float>(1.0 - std::exp(-1.0 / (t * fs)));
    };
    const float atk = onePole(mMorphAttack);
    const float rel = onePole(mMorphRelease);
    const bool  bassSrc = (mMorphSource == 1);

    for (int i = 0; i < n; ++i) {
        const float x = in[i];
        const float rect = std::fabs(x);
        mMorphEnv += (rect > mMorphEnv ? atk : rel) * (rect - mMorphEnv);

        if (bassSrc) {
            auto& s = mMorphLPState;
            double y = mMorphLPCoeffs.b0 * x + s.x1;
            s.x1 = mMorphLPCoeffs.b1 * x - mMorphLPCoeffs.a1 * y + s.x2;
            s.x2 = mMorphLPCoeffs.b2 * x - mMorphLPCoeffs.a2 * y;
            const float rb = std::fabs(static_cast<float>(y));
            mMorphBassEnv += (rb > mMorphBassEnv ? atk : rel) * (rb - mMorphBassEnv);
        }
    }

    auto lerp  = [](float a, float b, float t) { return a + (b - a) * t; };
    auto clamp01 = [](float v) { return v < 0.f ? 0.f : (v > 1.f ? 1.f : v); };

    float mapped;
    if (bassSrc) {
        const float ratio = clamp01(mMorphBassEnv / (mMorphEnv + 1e-9f));
        const float threshR = lerp(0.05f, 0.55f, mMorphThreshold);
        const float spanR   = lerp(0.55f, 0.10f, mMorphSensitivity);
        mapped = clamp01((ratio - threshR) / (spanR > 1e-4f ? spanR : 1e-4f));
    } else {
        const float envDb   = 20.f * std::log10(mMorphEnv + 1e-9f);
        const float threshDb = lerp(-60.f, 0.f, mMorphThreshold);
        const float spanDb   = lerp(40.f,  6.f, mMorphSensitivity);
        mapped = clamp01((envDb - threshDb) / (spanDb > 1e-3f ? spanDb : 1e-3f));
    }

    const float swept = mMorphInvert ? (1.f - mapped) : mapped;
    return clamp01(lerp(mMorphManual, swept, mMorphDepth));
}

// ── Per-channel chain STAGES (stereo mode) ────────────────────────────────────

void homecrate_ampDSPKernel::stageInput(int ch, const float* in, int n,
                                        float inGain, float normIn, bool skipHostStages)
{
    float* buf = ((ch == 0) ? mMonoBuf : mMonoBufR).data();

    const float  padFactor   = (skipHostStages || !mInputPad) ? 1.0f : 0.1f;
    const double totalInGain = skipHostStages ? 1.0 : static_cast<double>(normIn * inGain * padFactor);
    for (int i = 0; i < n; ++i) {
        double s = in[i] * totalInGain;
        if (s >  1.0) s =  1.0;
        if (s < -1.0) s = -1.0;
        buf[i] = static_cast<float>(s);
    }

    if (!skipHostStages && !mEQPostAmp)
        applyEQ(buf, n, ch);
}

void homecrate_ampDSPKernel::stagePreReverb(int ch, int n, bool reverbActive)
{
    CostelloReverbEngine* rev     = (ch == 0) ? mReverb  : mReverbR;
    float*                buf     = ((ch == 0) ? mMonoBuf : mMonoBufR).data();
    float*                gateBuf = ((ch == 0) ? mGateBuf : mGateBufR).data();

    if (mReverbPreAmp && reverbActive && rev) {
        if (mReverbGated)
            computeReverbGateGains(buf, gateBuf, n, ch);
        rev->process(buf, n);
        for (int i = 0; i < n; ++i) {
            float s = mReverbGated ? (buf[i] * gateBuf[i]) : buf[i];
            if (s >  1.0f) s =  1.0f;
            if (s < -1.0f) s = -1.0f;
            buf[i] = s;
        }
    }
}

void homecrate_ampDSPKernel::stageAmp(int ch, int n, float normOut, int fadeStart, bool skipHostStages)
{
    nam::DSP*             dsp    = (ch == 0) ? mDSP       : mDSPR;
    IRConvolver*          conv   = (ch == 0) ? mConvolver : mConvolverR;
    std::vector<double>&  inBuf  = (ch == 0) ? mNAMInBuf  : mNAMInBufR;
    std::vector<double>&  outBuf = (ch == 0) ? mNAMOutBuf : mNAMOutBufR;
    float*                buf    = ((ch == 0) ? mMonoBuf : mMonoBufR).data();

    if (dsp) {
        for (int i = 0; i < n; ++i)
            inBuf[i] = static_cast<NAM_SAMPLE>(buf[i]);

        NAM_SAMPLE* inPtr  = inBuf.data();
        NAM_SAMPLE* outPtr = outBuf.data();

        try {
            dsp->process(&inPtr, &outPtr, n);
        } catch (...) {
            for (int i = 0; i < n; ++i) outBuf[i] = inBuf[i];
        }

        for (int i = 0; i < n; ++i) {
            float s = static_cast<float>(outBuf[i]);
            buf[i] = std::isfinite(s) ? (s * normOut) : 0.f;
        }
    }

    if (fadeStart > 0) {
        const float invTotal = 1.0f / static_cast<float>(mFadeInSamples > 0 ? mFadeInSamples : 1);
        int fadeLeft = fadeStart;
        for (int i = 0; i < n && fadeLeft > 0; ++i) {
            const float ramp = 1.0f - static_cast<float>(fadeLeft) * invTotal;
            buf[i] *= ramp;
            --fadeLeft;
        }
    }

    if (conv && conv->isReady()) {
        conv->process(buf, buf, n);
        if (mIRNormalize) {
            const float s = mIRNormScale;
            for (int i = 0; i < n; ++i) buf[i] *= s;
        }
    }

    if (!skipHostStages && mEQPostAmp)
        applyEQ(buf, n, ch);
}

void homecrate_ampDSPKernel::stagePostReverb(int ch, int n, bool reverbActive)
{
    CostelloReverbEngine* rev = (ch == 0) ? mReverb  : mReverbR;
    float*                buf = ((ch == 0) ? mMonoBuf : mMonoBufR).data();

    if (!mReverbPreAmp && reverbActive && rev) {
        rev->process(buf, n);
    }
}

void homecrate_ampDSPKernel::stageOutput(int ch, float* out, int n, float outGain)
{
    const float* buf = ((ch == 0) ? mMonoBuf : mMonoBufR).data();

    const float outSign = (ch == 1 && mInvertR) ? -outGain : outGain;
    for (int i = 0; i < n; ++i)
        out[i] = buf[i] * outSign;
}

// ── Delay helpers ─────────────────────────────────────────────────────────────

int homecrate_ampDSPKernel::resolveDelaySeam() const {
    switch (mDelayPlacement) {
        case 0:  return mReverbPreAmp ? kDelaySeamA : kDelaySeamC;
        case 1:  return mReverbPreAmp ? kDelaySeamB : kDelaySeamD;
        default: return kDelaySeamD;
    }
}

void homecrate_ampDSPKernel::runDelayStereo(int n, bool clampAfter) {
    mDelay->processStereo(mMonoBuf.data(), mMonoBufR.data(), n);
    if (clampAfter) {
        for (int i = 0; i < n; ++i) {
            float l = mMonoBuf[i];
            float r = mMonoBufR[i];
            if (l >  1.0f) l =  1.0f;
            if (l < -1.0f) l = -1.0f;
            if (r >  1.0f) r =  1.0f;
            if (r < -1.0f) r = -1.0f;
            mMonoBuf[i]  = l;
            mMonoBufR[i] = r;
        }
    }
}

void homecrate_ampDSPKernel::refreshDelay() {
    if (!mDelay) return;
    if (mDelayDirty.exchange(false, std::memory_order_acq_rel)) {
        mDelay->setFeedback(mDelayFeedback);
        mDelay->setToneNorm(mDelayTone);
        mDelay->setMix(mDelayMix);
        mDelay->setPingPong(mDelayPingPong);
        mDelay->setTape(mDelayTape);
        mDelay->setDuck(mDelayDuck);
        if (!mDelaySync)
            mDelay->setTimeMs(mDelayTime);
    }
    if (mDelaySync) {
        const double tempo = mHostBPM.load(std::memory_order_relaxed);
        if (tempo > 0.0)
            mDelay->updateFromBPM(tempo, mDelayDivision);
        else
            mDelay->setTimeMs(mDelayTime);
    }
    mDelay->setOscillate(mDelayOscillate);
}
