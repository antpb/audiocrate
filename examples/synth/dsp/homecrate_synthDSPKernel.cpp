//
//  homecrate_synthDSPKernel.cpp
//  homecrate synth — VST3 port
//
//  Full implementation of the DSP kernel. Faithful port of the AUv3
//  homecrate_synthDSPKernel.mm; only the host-integration seams differ
//  (see the header). DSP behavior is intentionally identical.
//

#include "homecrate_synthDSPKernel.h"

#include "VoiceAllocator.h"
#include "LFO.h"
#include "BitCrusher.h"
#include "ChorusEngine.h"
#include "DelayEngine.h"
#include "CostelloReverbEngine.h"
#include "ADSREnvelope.h"
#include "PolyFilter.h"

#include "IRConvolver.h"
#include <cstring>
#include <cmath>
#include <algorithm>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ── IR Slot EQ (3-band biquad, Audio EQ Cookbook) ────────────────────────────

struct BiquadCoeffs { double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0; };
struct BiquadState  { double x1 = 0, x2 = 0, y1 = 0, y2 = 0; };

static constexpr int kIRSlots = 6;
static constexpr int kIREQBands = 3;

// Each IR slot needs per-voice convolvers and per-voice EQ state because the
// convolver (overlap-save) and biquad filters are stateful — sharing one instance
// across multiple voices causes intermodulation artifacts.
static constexpr int kMaxVoicesPerSlot = 8;

struct IRSlotState {
    ~IRSlotState() { teardownConvolvers(); }
    IRConvolver* convolvers[kMaxVoicesPerSlot] = {};
    bool  active     = false;
    float gain       = 1.0f;
    float eqGainDB[kIREQBands] = {};
    BiquadCoeffs eqCoeffs[kIREQBands] = {};
    BiquadState  eqState[kMaxVoicesPerSlot][kIREQBands] = {};
    bool  eqDirty    = true;

    bool hasConvolver() const { return convolvers[0] != nullptr; }

    void recomputeEQ(double sampleRate) {
        static const double kFreqs[kIREQBands] = { 80.0, 800.0, 8000.0 };
        static const double kQ = 0.707;
        const double fs = sampleRate > 0 ? sampleRate : 48000.0;

        for (int band = 0; band < kIREQBands; ++band) {
            const double dB  = static_cast<double>(eqGainDB[band]);
            const double fc  = kFreqs[band];
            const double A   = std::pow(10.0, dB / 40.0);
            const double w0  = 2.0 * M_PI * fc / fs;
            const double cosw = std::cos(w0);
            const double sinw = std::sin(w0);
            auto& c = eqCoeffs[band];

            if (dB == 0.0) { c = {1,0,0,0,0}; continue; }

            if (band == 0) { // Low Shelf
                const double alpha = sinw / 2.0 * std::sqrt((A + 1.0/A) * (1.0/kQ - 1.0) + 2.0);
                const double sqA = std::sqrt(A);
                const double a0 = (A+1) + (A-1)*cosw + 2*sqA*alpha;
                c.b0 = A*((A+1) - (A-1)*cosw + 2*sqA*alpha) / a0;
                c.b1 = 2*A*((A-1) - (A+1)*cosw) / a0;
                c.b2 = A*((A+1) - (A-1)*cosw - 2*sqA*alpha) / a0;
                c.a1 = -2*((A-1) + (A+1)*cosw) / a0;
                c.a2 = ((A+1) + (A-1)*cosw - 2*sqA*alpha) / a0;
            } else if (band == kIREQBands - 1) { // High Shelf
                const double alpha = sinw / 2.0 * std::sqrt((A + 1.0/A) * (1.0/kQ - 1.0) + 2.0);
                const double sqA = std::sqrt(A);
                const double a0 = (A+1) - (A-1)*cosw + 2*sqA*alpha;
                c.b0 = A*((A+1) + (A-1)*cosw + 2*sqA*alpha) / a0;
                c.b1 = -2*A*((A-1) + (A+1)*cosw) / a0;
                c.b2 = A*((A+1) + (A-1)*cosw - 2*sqA*alpha) / a0;
                c.a1 = 2*((A-1) - (A+1)*cosw) / a0;
                c.a2 = ((A+1) + (A-1)*cosw - 2*sqA*alpha) / a0;
            } else { // Peak Bell
                const double alpha = sinw * std::sinh(std::log(2.0)/2.0 * kQ * w0 / sinw);
                const double a0 = 1.0 + alpha/A;
                c.b0 = (1.0 + alpha*A) / a0;
                c.b1 = -(2.0*cosw) / a0;
                c.b2 = (1.0 - alpha*A) / a0;
                c.a1 = -(2.0*cosw) / a0;
                c.a2 = (1.0 - alpha/A) / a0;
            }
        }
        eqDirty = false;
    }

    void processEQ(float* buf, int frameCount, int voiceIdx) {
        int vi = std::min(voiceIdx, kMaxVoicesPerSlot - 1);
        for (int band = 0; band < kIREQBands; ++band) {
            if (eqGainDB[band] == 0.0f) continue;
            const auto& c = eqCoeffs[band];
            auto& s = eqState[vi][band];
            for (int i = 0; i < frameCount; ++i) {
                double x = buf[i];
                double y = c.b0 * x + s.x1;
                s.x1 = c.b1 * x - c.a1 * y + s.x2;
                s.x2 = c.b2 * x - c.a2 * y;
                buf[i] = static_cast<float>(y);
            }
        }
    }

    void resetEQState() {
        for (int v = 0; v < kMaxVoicesPerSlot; ++v)
            for (int b = 0; b < kIREQBands; ++b)
                eqState[v][b] = {};
    }

    void teardownConvolvers() {
        for (int i = 0; i < kMaxVoicesPerSlot; ++i) {
            delete convolvers[i];
            convolvers[i] = nullptr;
        }
    }
};

// ── Pimpl internals ──────────────────────────────────────────────────────────

struct homecrate_synthDSPKernel::Impl {
    VoiceAllocator   allocator;
    LFO              lfo1;
    LFO              lfo2;
    BitCrusher       crusher;
    ChorusEngine     chorus;
    DelayEngine      delay;
    CostelloReverbEngine reverb;
    std::vector<float> mixBuf;

    // External audio mode: dedicated envelope + filter (not per-voice)
    ADSREnvelope     extAmpEnv;
    ADSREnvelope     extFiltEnv;
    PolyFilter       extFilter;
    bool             extNoteActive = false;

    // Set by processWithInput() before calling process()
    const float* const* currentInputBuffers = nullptr;
    int currentNumInputs = 0;

    // Per-voice IR cabinet slots
    IRSlotState      irSlots[kIRSlots];
    KernelSpinLock   irLock;
    // Per-voice scratch buffer for IR processing
    std::vector<float> voiceScratchBuf;
};

// ── Constructor / Destructor ─────────────────────────────────────────────────

homecrate_synthDSPKernel::homecrate_synthDSPKernel() {
    pImpl = new Impl();

    // Parameter defaults
    mParams[oscAWaveform]       = 2.0f;
    mParams[oscACoarseTune]     = 0.0f;
    mParams[oscAFineTune]       = 0.0f;
    mParams[oscAShapeMod]       = 0.5f;
    mParams[oscBWaveform]       = 0.0f;
    mParams[oscBCoarseTune]     = 0.0f;
    mParams[oscBFineTune]       = 0.0f;
    mParams[oscBShapeMod]       = 0.5f;
    mParams[oscAOctave]         = 0.0f;
    mParams[oscBOctave]         = 0.0f;
    mParams[oscBlend]           = 0.0f;
    mParams[oscMasterLevel]     = 0.8f;
    mParams[ampAttack]          = 0.01f;
    mParams[ampDecay]           = 0.3f;
    mParams[ampSustain]         = 0.7f;
    mParams[ampRelease]         = 0.5f;
    mParams[filterType]         = 0.0f;
    mParams[filterCutoff]       = 2000.0f;
    mParams[filterResonance]    = 0.0f;
    mParams[filterEnvAmount]    = 0.0f;
    mParams[filtAttack]         = 0.01f;
    mParams[filtDecay]          = 0.3f;
    mParams[filtSustain]        = 1.0f;
    mParams[filtRelease]        = 0.5f;
    mParams[voiceMode]          = 0.0f;
    mParams[unisonCount]        = 1.0f;
    mParams[unisonDetune]       = 0.2f;
    mParams[glideTime]          = 0.0f;
    mParams[polyVoiceCount]     = 4.0f;
    mParams[crusherMix]         = 0.0f;
    mParams[crusherBitDepth]    = 16.0f;
    mParams[crusherSampleRate]  = 1.0f;
    mParams[chorusRate]         = 0.3f;
    mParams[chorusDepth]        = 0.5f;
    mParams[chorusMix]          = 0.0f;
    mParams[delaySync]          = 1.0f;
    mParams[delayFeedback]      = 0.3f;
    mParams[delayMix]           = 0.0f;
    mParams[delayTimeMs]        = 250.0f;
    mParams[reverbDecay]        = 0.3f;
    mParams[reverbSize]         = 1.0f;
    mParams[reverbPreDelay]     = 10.0f;
    mParams[reverbBlend]        = 0.0f;
    mParams[masterGain]         = 0.8f;
    mParams[masterPan]          = 0.0f;
    for (int i = 0; i < 6; ++i) mParams[unisonShape0 + i] = 0.5f;
    mParams[pitchBendRange]     = 2.0f;
    mParams[velocitySensitivity] = 0.8f;
    mParams[filterKeyTracking]  = 0.0f;
    mParams[extAudioMode]       = 0.0f;
    mParams[extVCABypass]       = 1.0f;
    mParams[extInputGain]       = 1.0f;

    // Per-Oscillator B defaults (match A defaults)
    mParams[ampBAttack]         = 0.01f;
    mParams[ampBDecay]          = 0.3f;
    mParams[ampBSustain]        = 0.7f;
    mParams[ampBRelease]        = 0.5f;
    mParams[filterBType]        = 0.0f;
    mParams[filterBCutoff]      = 2000.0f;
    mParams[filterBResonance]   = 0.0f;
    mParams[filterBEnvAmount]   = 0.0f;
    mParams[filterTopology]     = 0.0f;
    mParams[filterSlope]        = 1.0f;
    mParams[filterBTopology]    = 0.0f;
    mParams[filterBSlope]       = 1.0f;
    mParams[filtBAttack]        = 0.01f;
    mParams[filtBDecay]         = 0.3f;
    mParams[filtBSustain]       = 1.0f;
    mParams[filtBRelease]       = 0.5f;
    mParams[ampEnvLink]         = 1.0f;
    mParams[filterLink]         = 1.0f;
    mParams[filtEnvLink]        = 1.0f;
    mParams[oscALevel]          = 1.0f;
    mParams[oscBLevel]          = 1.0f;
    mParams[voiceStealMode]     = 0.0f;
    mParams[voicePriority]      = 0.0f;
    mParams[charTuningDrift]    = 0.0f;
    mParams[charFilterSpread]   = 0.0f;
    mParams[charShapeSpread]    = 0.0f;
    mParams[charGainSpread]     = 0.0f;
    mParams[charSeed]           = 0.0f;
    mParams[mpeEnabled]         = 0.0f;
    mParams[mpePitchBendRange]  = 48.0f;
    mParams[mpeYAxisDest]       = 0.0f;
    mParams[mpeZAxisDest]       = 2.0f;
    mParams[mpeYAxisAmount]     = 0.5f;
    mParams[mpeZAxisAmount]     = 0.5f;

    // Arpeggiator (runtime lives in the VST3 processor; DSP just stores the
    // values so presets round-trip.)
    mParams[arpEnabled]         = 0.0f;
    mParams[arpMode]            = 0.0f;
    mParams[arpRate]            = 4.0f;
    mParams[arpGate]            = 0.5f;
    mParams[arpDirection]       = 0.0f;
    mParams[arpOctaveRange]     = 1.0f;
    mParams[arpChordRandomize]  = 0.0f;
    mParams[arpLatch]           = 0.0f;
    mParams[arpStepCount]       = 4.0f;
    mParams[arpStep0Enabled]    = 1.0f;
    mParams[arpStep1Enabled]    = 1.0f;
    mParams[arpStep2Enabled]    = 1.0f;
    mParams[arpStep3Enabled]    = 1.0f;
    mParams[arpStep4Enabled]    = 0.0f;
    mParams[arpStep5Enabled]    = 0.0f;
    mParams[arpStep6Enabled]    = 0.0f;
    mParams[arpStep7Enabled]    = 0.0f;
    mParams[arpStep0Pitch]      = 0.0f;
    mParams[arpStep1Pitch]      = 3.0f;
    mParams[arpStep2Pitch]      = 7.0f;
    mParams[arpStep3Pitch]      = 10.0f;
    mParams[arpStep4Pitch]      = 0.0f;
    mParams[arpStep5Pitch]      = 0.0f;
    mParams[arpStep6Pitch]      = 0.0f;
    mParams[arpStep7Pitch]      = 0.0f;
    mParams[arpStep0Octave]     = 0.0f;
    mParams[arpStep1Octave]     = 0.0f;
    mParams[arpStep2Octave]     = 0.0f;
    mParams[arpStep3Octave]     = 0.0f;
    mParams[arpStep4Octave]     = 0.0f;
    mParams[arpStep5Octave]     = 0.0f;
    mParams[arpStep6Octave]     = 0.0f;
    mParams[arpStep7Octave]     = 0.0f;
}

homecrate_synthDSPKernel::~homecrate_synthDSPKernel() {
    delete pImpl;
}

double homecrate_synthDSPKernel::currentHostBPM() const {
    return mHostBPM.load(std::memory_order_relaxed);
}

void homecrate_synthDSPKernel::setHostBPM(double bpm) {
    if (bpm > 0.0) mHostBPM.store(bpm, std::memory_order_relaxed);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

void homecrate_synthDSPKernel::initialize(int channelCount, double inSampleRate) {
    (void)channelCount;
    mSampleRate = inSampleRate;
    pImpl->allocator.init(inSampleRate);
    pImpl->lfo1.init(inSampleRate);
    pImpl->lfo2.init(inSampleRate);
    pImpl->crusher.init();
    pImpl->chorus.init(inSampleRate);
    pImpl->delay.init(inSampleRate);
    pImpl->reverb.setup(inSampleRate);
    pImpl->mixBuf.resize(mMaxFramesToRender, 0.0f);
    pImpl->extAmpEnv.init(inSampleRate);
    pImpl->extFiltEnv.init(inSampleRate);
    pImpl->extFilter.init(inSampleRate);
    pImpl->extNoteActive = false;
    pImpl->voiceScratchBuf.resize(mMaxFramesToRender, 0.0f);
}

void homecrate_synthDSPKernel::deInitialize() {
    pImpl->allocator.allNotesOff();
    pImpl->chorus.reset();
    pImpl->delay.reset();
    pImpl->reverb.reset();
}

// ── Bypass ───────────────────────────────────────────────────────────────────

bool homecrate_synthDSPKernel::isBypassed() { return mBypassed; }
void homecrate_synthDSPKernel::setBypass(bool shouldBypass) { mBypassed = shouldBypass; }

// ── Parameters ───────────────────────────────────────────────────────────────

void homecrate_synthDSPKernel::setParameter(AUParameterAddress address, AUValue value) {
    if (address < synthParamCount) {
        mParams[address] = value;

        // Link propagation: when linked, mirror A↔B params
        if (mParams[ampEnvLink] >= 0.5f) {
            if (address == ampAttack)  mParams[ampBAttack]  = value;
            if (address == ampDecay)   mParams[ampBDecay]   = value;
            if (address == ampSustain) mParams[ampBSustain] = value;
            if (address == ampRelease) mParams[ampBRelease] = value;
            if (address == ampBAttack)  mParams[ampAttack]  = value;
            if (address == ampBDecay)   mParams[ampDecay]   = value;
            if (address == ampBSustain) mParams[ampSustain] = value;
            if (address == ampBRelease) mParams[ampRelease] = value;
        }
        if (mParams[filterLink] >= 0.5f) {
            if (address == filterType)       mParams[filterBType]       = value;
            if (address == filterCutoff)     mParams[filterBCutoff]     = value;
            if (address == filterResonance)  mParams[filterBResonance]  = value;
            if (address == filterEnvAmount)  mParams[filterBEnvAmount]  = value;
            if (address == filterTopology)   mParams[filterBTopology]   = value;
            if (address == filterSlope)      mParams[filterBSlope]      = value;
            if (address == filterBType)      mParams[filterType]        = value;
            if (address == filterBCutoff)    mParams[filterCutoff]      = value;
            if (address == filterBResonance) mParams[filterResonance]   = value;
            if (address == filterBEnvAmount) mParams[filterEnvAmount]   = value;
            if (address == filterBTopology)  mParams[filterTopology]    = value;
            if (address == filterBSlope)     mParams[filterSlope]       = value;
        }
        if (mParams[filtEnvLink] >= 0.5f) {
            if (address == filtAttack)  mParams[filtBAttack]  = value;
            if (address == filtDecay)   mParams[filtBDecay]   = value;
            if (address == filtSustain) mParams[filtBSustain] = value;
            if (address == filtRelease) mParams[filtBRelease] = value;
            if (address == filtBAttack)  mParams[filtAttack]  = value;
            if (address == filtBDecay)   mParams[filtDecay]   = value;
            if (address == filtBSustain) mParams[filtSustain] = value;
            if (address == filtBRelease) mParams[filtRelease] = value;
        }

        // When re-linking, snap B to match A
        if (address == ampEnvLink && value >= 0.5f) {
            mParams[ampBAttack]  = mParams[ampAttack];
            mParams[ampBDecay]   = mParams[ampDecay];
            mParams[ampBSustain] = mParams[ampSustain];
            mParams[ampBRelease] = mParams[ampRelease];
        }
        if (address == filterLink && value >= 0.5f) {
            mParams[filterBType]      = mParams[filterType];
            mParams[filterBCutoff]    = mParams[filterCutoff];
            mParams[filterBResonance] = mParams[filterResonance];
            mParams[filterBEnvAmount] = mParams[filterEnvAmount];
            mParams[filterBTopology]  = mParams[filterTopology];
            mParams[filterBSlope]     = mParams[filterSlope];
        }
        if (address == filtEnvLink && value >= 0.5f) {
            mParams[filtBAttack]  = mParams[filtAttack];
            mParams[filtBDecay]   = mParams[filtDecay];
            mParams[filtBSustain] = mParams[filtSustain];
            mParams[filtBRelease] = mParams[filtRelease];
        }
    }
}

AUValue homecrate_synthDSPKernel::getParameter(AUParameterAddress address) {
    if (address < synthParamCount) return mParams[address];
    return 0.f;
}

// ── Max Frames ───────────────────────────────────────────────────────────────

AUAudioFrameCount homecrate_synthDSPKernel::maximumFramesToRender() const { return mMaxFramesToRender; }

void homecrate_synthDSPKernel::setMaximumFramesToRender(const AUAudioFrameCount &maxFrames) {
    mMaxFramesToRender = maxFrames;
    pImpl->mixBuf.resize(maxFrames, 0.0f);
    pImpl->voiceScratchBuf.resize(maxFrames, 0.0f);
}

// ── MIDI ─────────────────────────────────────────────────────────────────────

void homecrate_synthDSPKernel::triggerNoteOn(int note, float velocity) {
    handleMIDINoteOn(static_cast<unsigned char>(note), velocity);
}

void homecrate_synthDSPKernel::triggerNoteOff(int note) {
    handleMIDINoteOff(static_cast<unsigned char>(note));
}

void homecrate_synthDSPKernel::triggerMPENoteOn(int note, float velocity, int channel) {
    handleMPENoteOn(static_cast<unsigned char>(note), velocity, static_cast<unsigned char>(channel));
}

void homecrate_synthDSPKernel::setPitchBendNorm(float norm) {
    mPitchBendSemitones = norm * mParams[pitchBendRange];
}

void homecrate_synthDSPKernel::setMPEPitchBendNorm(int channel, float norm) {
    pImpl->allocator.setMPEPitchBend(channel, norm * mParams[mpePitchBendRange]);
}

void homecrate_synthDSPKernel::setMPEPressure(int channel, float pressure) {
    pImpl->allocator.setMPEPressure(channel, pressure);
}

void homecrate_synthDSPKernel::setMPESlide(int channel, float slide) {
    pImpl->allocator.setMPESlide(channel, slide);
}

void homecrate_synthDSPKernel::allNotesOff() {
    pImpl->allocator.allNotesOff();
}

bool homecrate_synthDSPKernel::anyVoiceActive() const {
    int maxVoices = static_cast<int>(mParams[polyVoiceCount]);
    if (maxVoices < 1) maxVoices = 8;
    return pImpl->allocator.anyVoiceActive(maxVoices);
}

void homecrate_synthDSPKernel::getVoiceDisplayInfo(SynthVoiceDisplayInfo* outInfo, int count) const {
    VoiceDisplayState states[VoiceAllocator::kMaxVoices];
    pImpl->allocator.getDisplayStates(states, std::min(count, (int)VoiceAllocator::kMaxVoices));
    for (int i = 0; i < std::min(count, (int)VoiceAllocator::kMaxVoices); ++i) {
        outInfo[i].noteNumber = states[i].noteNumber;
        outInfo[i].amplitude  = states[i].amplitude;
        outInfo[i].envStage   = states[i].envStage;
        outInfo[i].active     = states[i].active;
    }
}

void homecrate_synthDSPKernel::setIRForSlot(int slotIndex, const float* data, int sampleCount) {
    if (slotIndex < 0 || slotIndex >= kIRSlots) return;

    // Create all per-voice convolvers off the audio thread
    IRConvolver* newConvs[kMaxVoicesPerSlot] = {};
    for (int i = 0; i < kMaxVoicesPerSlot; ++i) {
        newConvs[i] = new IRConvolver();
        newConvs[i]->setup(data, sampleCount, 512);
    }

    pImpl->irLock.lock();
    auto& slot = pImpl->irSlots[slotIndex];
    slot.teardownConvolvers();
    for (int i = 0; i < kMaxVoicesPerSlot; ++i)
        slot.convolvers[i] = newConvs[i];
    slot.active = true;
    slot.resetEQState();
    pImpl->irLock.unlock();
}

void homecrate_synthDSPKernel::clearIRForSlot(int slotIndex) {
    if (slotIndex < 0 || slotIndex >= kIRSlots) return;
    pImpl->irLock.lock();
    pImpl->irSlots[slotIndex].teardownConvolvers();
    pImpl->irSlots[slotIndex].active = false;
    pImpl->irLock.unlock();
}

void homecrate_synthDSPKernel::setTuningTable(const float* cents, int count) {
    int n = std::min(count, 128);
    for (int i = 0; i < n; ++i) mTuningTableCents[i] = cents[i];
    for (int i = n; i < 128; ++i) mTuningTableCents[i] = 0.0f;
}

void homecrate_synthDSPKernel::handleMIDINoteOn(unsigned char note, float velocity) {
    bool isMono = mParams[voiceMode] >= 0.5f;
    if (isMono) {
        pImpl->allocator.monoNoteOn(note, velocity, static_cast<int>(mParams[unisonCount]));
    } else {
        pImpl->allocator.polyNoteOn(note, velocity, static_cast<int>(mParams[polyVoiceCount]));
    }
    // Trigger ext audio envelopes (used when extAudioMode is on)
    pImpl->extAmpEnv.noteOn();
    pImpl->extFiltEnv.noteOn();
    pImpl->extNoteActive = true;
}

void homecrate_synthDSPKernel::handleMPENoteOn(unsigned char note, float velocity, unsigned char channel) {
    bool isMono = mParams[voiceMode] >= 0.5f;
    if (isMono) {
        pImpl->allocator.monoNoteOn(note, velocity, static_cast<int>(mParams[unisonCount]));
    } else {
        int maxVoices = static_cast<int>(mParams[polyVoiceCount]);
        pImpl->allocator.polyNoteOn(note, velocity, maxVoices);
        // Find the voice that got this note and assign the MPE channel
        for (int i = 0; i < maxVoices; ++i) {
            if (pImpl->allocator.voices()[i].isActive() && pImpl->allocator.voices()[i].noteNumber() == note) {
                pImpl->allocator.setMPEChannel(i, channel);
                break;
            }
        }
    }
    pImpl->extAmpEnv.noteOn();
    pImpl->extFiltEnv.noteOn();
    pImpl->extNoteActive = true;
}

void homecrate_synthDSPKernel::handleMIDINoteOff(unsigned char note) {
    bool isMono = mParams[voiceMode] >= 0.5f;
    if (isMono) {
        pImpl->allocator.monoNoteOff(note);
    } else {
        pImpl->allocator.polyNoteOff(note);
    }
    // Release ext audio envelopes
    pImpl->extAmpEnv.noteOff();
    pImpl->extFiltEnv.noteOff();
    pImpl->extNoteActive = false;
}

// ── Process (render thread) ──────────────────────────────────────────────────

void homecrate_synthDSPKernel::process(float** outputBuffers, int numChannels, AUEventSampleTime bufferStartTime, AUAudioFrameCount frameCount) {
    (void)bufferStartTime;
    if (mBypassed || frameCount == 0) {
        for (int channel = 0; channel < numChannels; ++channel)
            std::fill_n(outputBuffers[channel], frameCount, 0.f);
        return;
    }

    // Host BPM arrives via setHostBPM() from the VST3 ProcessContext each
    // block (replaces the AUv3's musicalContextBlock polling).

    // ── LFO processing ──
    pImpl->lfo1.setRate(mParams[lfo1Rate]);
    pImpl->lfo1.setDepth(mParams[lfo1Depth]);
    pImpl->lfo1.setShape(static_cast<int>(mParams[lfo1Shape]));
    pImpl->lfo1.setDestination(static_cast<int>(mParams[lfo1Destination]));
    float lfo1Val = pImpl->lfo1.process(frameCount);

    pImpl->lfo2.setRate(mParams[lfo2Rate]);
    pImpl->lfo2.setDepth(mParams[lfo2Depth]);
    pImpl->lfo2.setShape(static_cast<int>(mParams[lfo2Shape]));
    pImpl->lfo2.setDestination(static_cast<int>(mParams[lfo2Destination]));
    float lfo2Val = pImpl->lfo2.process(frameCount);

    // Accumulate LFO modulation per destination
    float modFilterCutoff = 0.0f, modOscAPitch = 0.0f, modOscBPitch = 0.0f;
    float modOscBlend = 0.0f, modAmp = 0.0f, modPan = 0.0f;
    float modOscAShape = 0.0f, modOscBShape = 0.0f;

    // Pitch gets an extra ×depth (square-law): knob depth 0.1 ≈ ±0.12 st vibrato,
    // 0.3 ≈ ±1 st, 1.0 = ±12 st. Linear depth made everything below 0.05 the
    // entire usable vibrato range.
    auto applyLFO = [&](LFO::Destination dest, float val, float depth) {
        switch (dest) {
            case LFO::FilterCutoff: modFilterCutoff += val; break;
            case LFO::OscAPitch:    modOscAPitch    += val * depth; break;
            case LFO::OscBPitch:    modOscBPitch    += val * depth; break;
            case LFO::OscBlend:     modOscBlend     += val; break;
            case LFO::Amp:          modAmp          += val; break;
            case LFO::Pan:          modPan          += val; break;
            case LFO::OscAShape:    modOscAShape    += val; break;
            case LFO::OscBShape:    modOscBShape    += val; break;
            default: break;
        }
    };
    applyLFO(pImpl->lfo1.destination(), lfo1Val, pImpl->lfo1.depth());
    applyLFO(pImpl->lfo2.destination(), lfo2Val, pImpl->lfo2.depth());

    // Build voice params with LFO modulation applied
    SynthVoiceParams vp;
    vp.oscAWaveform        = static_cast<int>(mParams[oscAWaveform]);
    // Oct / coarse / fine params are normalized -1..1 (knob centre = 0); map to voice units here.
    {
        const float aOct = std::clamp(mParams[oscAOctave], -1.0f, 1.0f);
        vp.oscAOctave      = static_cast<int>(std::round(aOct * 3.0f));
        vp.oscAOctave      = std::clamp(vp.oscAOctave, -3, 3);
    }
    vp.oscACoarseTune      = std::clamp(mParams[oscACoarseTune], -1.0f, 1.0f) * 24.0f + modOscAPitch * 12.0f;
    vp.oscAFineTune        = std::clamp(mParams[oscAFineTune], -1.0f, 1.0f) * 100.0f;
    vp.oscAShapeMod        = std::clamp(mParams[oscAShapeMod] + modOscAShape * 0.5f, 0.0f, 1.0f);
    vp.oscBWaveform        = static_cast<int>(mParams[oscBWaveform]);
    {
        const float bOct = std::clamp(mParams[oscBOctave], -1.0f, 1.0f);
        vp.oscBOctave      = static_cast<int>(std::round(bOct * 3.0f));
        vp.oscBOctave      = std::clamp(vp.oscBOctave, -3, 3);
    }
    vp.oscBCoarseTune      = std::clamp(mParams[oscBCoarseTune], -1.0f, 1.0f) * 24.0f + modOscBPitch * 12.0f;
    vp.oscBFineTune        = std::clamp(mParams[oscBFineTune], -1.0f, 1.0f) * 100.0f;
    vp.oscBShapeMod        = std::clamp(mParams[oscBShapeMod] + modOscBShape * 0.5f, 0.0f, 1.0f);
    vp.oscBlend            = std::clamp(mParams[oscBlend] + modOscBlend * 0.5f, -1.0f, 1.0f);
    vp.oscMasterLevel      = std::clamp(mParams[oscMasterLevel] * (1.0f + modAmp), 0.0f, 1.0f);
    vp.oscALevel           = mParams[oscALevel];
    vp.oscBLevel           = mParams[oscBLevel];
    vp.ampAttack           = mParams[ampAttack];
    vp.ampDecay            = mParams[ampDecay];
    vp.ampSustain          = mParams[ampSustain];
    vp.ampRelease          = mParams[ampRelease];
    vp.filterType          = static_cast<int>(mParams[filterType]);
    // Cutoff modulation is multiplicative (octaves), not linear Hz — full LFO
    // depth sweeps ±4 octaves around the base cutoff regardless of where it sits.
    vp.filterCutoff        = std::clamp(mParams[filterCutoff] * exp2f(modFilterCutoff * 4.0f), 20.0f, 20000.0f);
    vp.filterResonance     = mParams[filterResonance];
    vp.filterEnvAmount     = mParams[filterEnvAmount];
    vp.filtAttack          = mParams[filtAttack];
    vp.filtDecay           = mParams[filtDecay];
    vp.filtSustain         = mParams[filtSustain];
    vp.filtRelease         = mParams[filtRelease];
    vp.filterKeyTracking   = mParams[filterKeyTracking];
    vp.velocitySensitivity = mParams[velocitySensitivity];
    vp.pitchBendSemitones  = mPitchBendSemitones;

    // Per-Oscillator B params
    vp.ampBAttack          = mParams[ampBAttack];
    vp.ampBDecay           = mParams[ampBDecay];
    vp.ampBSustain         = mParams[ampBSustain];
    vp.ampBRelease         = mParams[ampBRelease];
    vp.filterBType         = static_cast<int>(mParams[filterBType]);
    vp.filterBCutoff       = std::clamp(mParams[filterBCutoff] * exp2f(modFilterCutoff * 4.0f), 20.0f, 20000.0f);
    vp.filterBResonance    = mParams[filterBResonance];
    vp.filterBEnvAmount    = mParams[filterBEnvAmount];
    vp.filtBAttack         = mParams[filtBAttack];
    vp.filtBDecay          = mParams[filtBDecay];
    vp.filtBSustain        = mParams[filtBSustain];
    vp.filtBRelease        = mParams[filtBRelease];
    vp.filterTopology      = static_cast<int>(mParams[filterTopology]);
    vp.filterSlope         = static_cast<int>(mParams[filterSlope]);
    vp.filterBTopology     = static_cast<int>(mParams[filterBTopology]);
    vp.filterBSlope        = static_cast<int>(mParams[filterBSlope]);

    // Microtonal tuning table
    vp.tuningTableCents    = mTuningTableCents;

    // MPE destination routing params (per-voice pitch/pressure/slide set in renderPoly)
    vp.mpeYDest            = static_cast<int>(mParams[mpeYAxisDest]);
    vp.mpeZDest            = static_cast<int>(mParams[mpeZAxisDest]);
    vp.mpeYAmount          = mParams[mpeYAxisAmount];
    vp.mpeZAmount          = mParams[mpeZAxisAmount];

    // Clear mix buffer
    float* mixBuf = pImpl->mixBuf.data();
    std::memset(mixBuf, 0, sizeof(float) * frameCount);

    const bool extMode = mParams[extAudioMode] >= 0.5f;

    if (extMode && pImpl->currentInputBuffers && pImpl->currentNumInputs > 0) {
        // ── External audio mode ──────────────────────────────────────────────
        const float inputGain = mParams[extInputGain];
        const float* inL = (pImpl->currentNumInputs > 0) ? pImpl->currentInputBuffers[0] : nullptr;
        const float* inR = (pImpl->currentNumInputs > 1) ? pImpl->currentInputBuffers[1] : nullptr;

        // Configure ext envelopes from same ADSR params as the synth
        pImpl->extAmpEnv.setAttack(mParams[ampAttack]);
        pImpl->extAmpEnv.setDecay(mParams[ampDecay]);
        pImpl->extAmpEnv.setSustain(mParams[ampSustain]);
        pImpl->extAmpEnv.setRelease(mParams[ampRelease]);

        pImpl->extFiltEnv.setAttack(mParams[filtAttack]);
        pImpl->extFiltEnv.setDecay(mParams[filtDecay]);
        pImpl->extFiltEnv.setSustain(mParams[filtSustain]);
        pImpl->extFiltEnv.setRelease(mParams[filtRelease]);

        // Configure ext filter
        pImpl->extFilter.setTopology(static_cast<int>(mParams[filterTopology]));
        pImpl->extFilter.setOrder(static_cast<int>(mParams[filterSlope]) + 1);
        pImpl->extFilter.setType(static_cast<int>(mParams[filterType]));
        pImpl->extFilter.setResonance(mParams[filterResonance]);

        float filtEnvStart = pImpl->extFiltEnv.value();
        // Env amount in octaves (±6 at full), matching SynthVoice's filter env scaling.
        float extCutoff = vp.filterCutoff
            * exp2f(mParams[filterEnvAmount] * filtEnvStart * 6.0f);
        extCutoff = std::clamp(extCutoff, 20.0f, 20000.0f);
        pImpl->extFilter.setCutoff(extCutoff);

        const bool vcaBypass = mParams[extVCABypass] >= 0.5f;

        for (AUAudioFrameCount i = 0; i < frameCount; ++i) {
            // Mono-sum input
            float mono = 0.0f;
            if (inL) mono += inL[i];
            if (inR) mono += inR[i];
            if (inL && inR) mono *= 0.5f;
            mono *= inputGain;

            // VCA: gate with amp envelope or bypass
            if (!vcaBypass) {
                float envVal = pImpl->extAmpEnv.process();
                mono *= envVal;
            }

            // Advance filter envelope
            pImpl->extFiltEnv.process();

            // Apply filter
            mono = pImpl->extFilter.process(mono);

            mixBuf[i] = mono;
        }
    } else {
        // ── Normal synth mode ────────────────────────────────────────────────
        pImpl->allocator.setStealMode(static_cast<int>(mParams[voiceStealMode]));
        pImpl->allocator.setPriority(static_cast<int>(mParams[voicePriority]));
        pImpl->allocator.setCharacterParams(
            mParams[charTuningDrift], mParams[charFilterSpread],
            mParams[charShapeSpread], mParams[charGainSpread],
            static_cast<int>(mParams[charSeed]));
        pImpl->allocator.refreshCharacterForActiveVoices(static_cast<int>(mParams[polyVoiceCount]));
        // Update IR slot parameters from mParams
        for (int s = 0; s < kIRSlots; ++s) {
            int base = irSlot0Active + s * 5;
            auto& slot = pImpl->irSlots[s];
            slot.active = slot.hasConvolver() && mParams[base] >= 0.5f;
            slot.gain   = mParams[base + 1];
            bool eqChanged = false;
            for (int b = 0; b < kIREQBands; ++b) {
                float newDB = mParams[base + 2 + b];
                if (newDB != slot.eqGainDB[b]) { slot.eqGainDB[b] = newDB; eqChanged = true; }
            }
            if (eqChanged || slot.eqDirty) slot.recomputeEQ(mSampleRate);
        }

        bool isMono = mParams[voiceMode] >= 0.5f;
        if (isMono) {
            int uCount = static_cast<int>(mParams[unisonCount]);
            float detuneSpread = mParams[unisonDetune];
            float unisonShapes[6];
            for (int i = 0; i < 6; ++i) unisonShapes[i] = mParams[unisonShape0 + i];

            bool anyIRActiveMono = pImpl->irSlots[0].active || pImpl->irSlots[1].active;
            float* scratch = pImpl->voiceScratchBuf.data();
            auto* uVoices = pImpl->allocator.unisonVoices();

            if (anyIRActiveMono && pImpl->irLock.try_lock()) {
                // Per-unison-voice IR: render each voice individually
                int count = std::min(uCount, (int)VoiceAllocator::kMaxUnison);
                for (int i = 0; i < count; ++i) {
                    float detuneOffset = 0.0f;
                    if (count > 1) {
                        float maxDet = detuneSpread * 0.5f;
                        float pos = static_cast<float>(i) / static_cast<float>(count - 1);
                        detuneOffset = (pos * 2.0f - 1.0f) * maxDet;
                    }
                    SynthVoiceParams voiceParams = vp;
                    voiceParams.oscAShapeMod = unisonShapes[i];

                    std::memset(scratch, 0, sizeof(float) * frameCount);
                    uVoices[i].render(scratch, frameCount, voiceParams, detuneOffset);

                    // Route through IR: even → slot A, odd → slot B
                    int slotIdx = i % 2;
                    int convIdx = i / 2;
                    auto& slot = pImpl->irSlots[slotIdx];
                    if (slot.active && slot.convolvers[convIdx] && slot.convolvers[convIdx]->isReady()) {
                        slot.convolvers[convIdx]->process(scratch, scratch, frameCount);
                        if (slot.gain != 1.0f) {
                            float g = slot.gain;
                            for (AUAudioFrameCount j = 0; j < frameCount; ++j) scratch[j] *= g;
                        }
                        slot.processEQ(scratch, frameCount, convIdx);
                    }

                    for (AUAudioFrameCount j = 0; j < frameCount; ++j) mixBuf[j] += scratch[j];
                }
                pImpl->irLock.unlock();
            } else {
                // No IR or lock contention — normal mono render
                pImpl->allocator.renderMono(mixBuf, frameCount, vp, uCount, detuneSpread, unisonShapes);
            }
        } else {
            // Per-voice IR rendering: render each voice to scratch, apply IR, add to mix
            int maxVoices = static_cast<int>(mParams[polyVoiceCount]);
            bool anyIRActive = pImpl->irSlots[0].active || pImpl->irSlots[1].active;
            float* scratch = pImpl->voiceScratchBuf.data();
            auto* voices = pImpl->allocator.voices();

            if (anyIRActive && pImpl->irLock.try_lock()) {
                // Per-voice render with IR routing
                for (int i = 0; i < maxVoices; ++i) {
                    if (!voices[i].isActive()) continue;
                    // Build per-voice params with MPE
                    SynthVoiceParams voiceVP = vp;
                    const auto& mpeState = pImpl->allocator.getMPEState(i);
                    voiceVP.mpePitchBendST = mpeState.pitchBendSemitones;
                    voiceVP.mpePressure    = mpeState.pressure;
                    voiceVP.mpeSlide       = mpeState.slide;

                    // Render voice to scratch buffer
                    std::memset(scratch, 0, sizeof(float) * frameCount);
                    voices[i].render(scratch, frameCount, voiceVP);

                    // Apply IR for this voice's slot (even voices → slot 0, odd → slot 1)
                    int slotIdx = i % 2;
                    int convIdx = i / 2;
                    auto& slot = pImpl->irSlots[slotIdx];
                    if (slot.active && slot.convolvers[convIdx] && slot.convolvers[convIdx]->isReady()) {
                        slot.convolvers[convIdx]->process(scratch, scratch, frameCount);
                        // Apply slot gain
                        if (slot.gain != 1.0f) {
                            float g = slot.gain;
                            for (AUAudioFrameCount j = 0; j < frameCount; ++j) scratch[j] *= g;
                        }
                        // Apply 3-band EQ
                        slot.processEQ(scratch, frameCount, convIdx);
                    }

                    // Add to mix
                    for (AUAudioFrameCount j = 0; j < frameCount; ++j) mixBuf[j] += scratch[j];
                }
                // Update display states
                pImpl->allocator.updateDisplayStatesExternal(maxVoices);
                pImpl->irLock.unlock();
            } else {
                // No IR active or lock contention — render normally
                pImpl->allocator.renderPoly(mixBuf, frameCount, vp, maxVoices);
            }
        }
    }

    // Effects chain
    pImpl->delay.updateFromBPM(mHostBPM.load(std::memory_order_relaxed), static_cast<int>(mParams[delaySync]));

    // Longer modulated FDN delays → DECAY can reach much longer tails.
    float reverbFeedback = 0.70f + mParams[reverbDecay] * 0.27f;   // 0.70 … 0.97
    pImpl->reverb.setFeedback(reverbFeedback);
    pImpl->reverb.setSize(mParams[reverbSize]);
    pImpl->reverb.setPreDelayMs(mParams[reverbPreDelay]);
    pImpl->reverb.setBlend(mParams[reverbBlend]);
    // Damping decoupled from the wet mix (was 7000 − blend*5200, which darkened
    // the tail into a distant room as WET rose). Fixed bright cutoff ≈ the amp's
    // default TONE so wet only changes the mix, not the tone.
    pImpl->reverb.setCutoff(5250.0f);

    pImpl->crusher.process(mixBuf, frameCount, mParams[crusherMix],
                           mParams[crusherBitDepth], mParams[crusherSampleRate]);
    pImpl->chorus.process(mixBuf, frameCount, mParams[chorusRate],
                          mParams[chorusDepth], mParams[chorusMix]);
    pImpl->delay.process(mixBuf, frameCount, mParams[delayFeedback], mParams[delayMix]);
    pImpl->reverb.process(mixBuf, frameCount);

    // Master gain + pan → stereo output
    float masterGainVal = mParams[masterGain];
    float pan = std::clamp(mParams[masterPan] + modPan, -1.0f, 1.0f);
    float panL = cosf((pan + 1.0f) * 0.25f * static_cast<float>(M_PI));
    float panR = sinf((pan + 1.0f) * 0.25f * static_cast<float>(M_PI));

    if (numChannels >= 2) {
        for (AUAudioFrameCount i = 0; i < frameCount; ++i) {
            float s = mixBuf[i] * masterGainVal;
            outputBuffers[0][i] = s * panL;
            outputBuffers[1][i] = s * panR;
        }
    } else if (numChannels >= 1) {
        for (AUAudioFrameCount i = 0; i < frameCount; ++i) {
            outputBuffers[0][i] = mixBuf[i] * masterGainVal;
        }
    }

    // Clear input pointers after processing
    pImpl->currentInputBuffers = nullptr;
    pImpl->currentNumInputs = 0;
}

// ── Process with external input (called from the VST3 processor) ─────────────

void homecrate_synthDSPKernel::processWithInput(const float* const* inputBuffers, int numInputs,
                                                 float** outputBuffers, int numOutputs,
                                                 AUEventSampleTime bufferStartTime, AUAudioFrameCount frameCount) {
    // Store input buffer pointers so process() can access them in ext mode
    pImpl->currentInputBuffers = inputBuffers;
    pImpl->currentNumInputs = numInputs;
    process(outputBuffers, numOutputs, bufferStartTime, frameCount);
}
