//
//  SynthVoice.h
//  homecrate synth
//
//  A single synthesizer voice containing:
//    - 2 oscillators (A + B) with blend
//    - 2 ADSR envelopes (amplitude + filter)
//    - 1 state-variable filter
//
//  Supports both polyphonic and unison sub-voice operation.
//

#pragma once

#include "SynthOscillator.h"
#include "ADSREnvelope.h"
#include "PolyFilter.h"
#include <cstring>

struct SynthVoiceParams {
    // Oscillators
    int   oscAWaveform    = 2;      // Saw
    float oscACoarseTune  = 0.0f;   // semitones
    float oscAFineTune    = 0.0f;   // cents
    float oscAShapeMod    = 0.5f;
    int   oscAOctave      = 0;      // -3..+3 octaves
    int   oscBWaveform    = 0;      // Sine
    float oscBCoarseTune  = 0.0f;
    float oscBFineTune    = 0.0f;
    float oscBShapeMod    = 0.5f;
    int   oscBOctave      = 0;      // -3..+3 octaves
    float oscBlend        = 0.0f;   // -1=A only, 0=balanced, +1=B only
    float oscMasterLevel  = 0.8f;
    float oscALevel       = 1.0f;  // pre-blend per-osc volume
    float oscBLevel       = 1.0f;

    // Amp envelope
    float ampAttack       = 0.01f;
    float ampDecay        = 0.3f;
    float ampSustain      = 0.7f;
    float ampRelease      = 0.5f;

    // Filter
    int   filterType      = 0;      // LP
    float filterCutoff    = 2000.0f;
    float filterResonance = 0.0f;
    float filterEnvAmount = 0.0f;

    // Filter envelope
    float filtAttack      = 0.01f;
    float filtDecay       = 0.3f;
    float filtSustain     = 1.0f;
    float filtRelease     = 0.5f;

    // Amp envelope B (per-osc)
    float ampBAttack      = 0.01f;
    float ampBDecay       = 0.3f;
    float ampBSustain     = 0.7f;
    float ampBRelease     = 0.5f;

    // Filter B (per-osc)
    int   filterBType     = 0;
    float filterBCutoff   = 2000.0f;
    float filterBResonance = 0.0f;
    float filterBEnvAmount = 0.0f;

    // Filter topology / slope
    int   filterTopology   = 0;   // 0=SVF, 1=Ladder, 2=Cascade
    int   filterSlope      = 1;   // 0=6dB, 1=12dB, 2=18dB, 3=24dB
    int   filterBTopology  = 0;
    int   filterBSlope     = 1;

    // Filter envelope B (per-osc)
    float filtBAttack     = 0.01f;
    float filtBDecay      = 0.3f;
    float filtBSustain    = 1.0f;
    float filtBRelease    = 0.5f;

    // Key tracking
    float filterKeyTracking  = 0.0f;
    float velocitySensitivity = 0.8f;
    float pitchBendSemitones = 0.0f;  // Current pitch bend in semitones

    // Microtonal: pointer to 128-entry cents deviation table (owned by kernel)
    const float* tuningTableCents = nullptr;

    // MPE per-voice modulation (set per-voice before render)
    float mpePitchBendST     = 0.0f;  // per-voice pitch bend in semitones
    float mpePressure        = 0.0f;  // Y-axis (0–1)
    float mpeSlide           = 0.0f;  // Z-axis / CC74 (0–1)
    int   mpeYDest           = 0;     // destination index
    int   mpeZDest           = 2;     // destination index
    float mpeYAmount         = 0.5f;
    float mpeZAmount         = 0.5f;
};

class SynthVoice {
public:
    SynthVoice() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        mOscA.init();
        mOscB.init();
        mAmpEnv.init(sampleRate);
        mFiltEnv.init(sampleRate);
        mFilter.init(sampleRate);
        mAmpEnvB.init(sampleRate);
        mFiltEnvB.init(sampleRate);
        mFilterB.init(sampleRate);
        mActive = false;
        mNoteNumber = -1;
        mVelocity = 0.0f;
        mNoteOnTimestamp = 0;
    }

    void noteOn(int note, float velocity, uint64_t timestamp) {
        mNoteNumber = note;
        mVelocity = velocity;
        mNoteOnTimestamp = timestamp;
        mActive = true;
        mAmpEnv.noteOn();
        mFiltEnv.noteOn();
        mAmpEnvB.noteOn();
        mFiltEnvB.noteOn();
    }

    void noteOff() {
        mAmpEnv.noteOff();
        mFiltEnv.noteOff();
        mAmpEnvB.noteOff();
        mFiltEnvB.noteOff();
    }

    bool isActive() const { return mActive; }
    int noteNumber() const { return mNoteNumber; }
    float velocity() const { return mVelocity; }
    uint64_t noteOnTimestamp() const { return mNoteOnTimestamp; }
    bool isReleasing() const { return mAmpEnv.stage() == ADSREnvelope::Release && mAmpEnvB.stage() == ADSREnvelope::Release; }
    float ampEnvValue() const { return mAmpEnv.value(); }
    int ampEnvStage() const { return static_cast<int>(mAmpEnv.stage()); }

    // Per-voice character offsets (set by VoiceAllocator on noteOn)
    void setCharacter(float tuningCents, float filterMul, float shapeOffset, float gainDB) {
        mCharTuningCents = tuningCents;
        mCharFilterMul   = filterMul;
        mCharShapeOffset = shapeOffset;
        mCharGainLinear  = powf(10.0f, gainDB / 20.0f);
    }

    // Render a block of samples into the output buffer (additive)
    void render(float* output, int frameCount, const SynthVoiceParams& params, float detuneOffset = 0.0f) {
        if (!mActive) return;

        // Update envelope A parameters
        mAmpEnv.setAttack(params.ampAttack);
        mAmpEnv.setDecay(params.ampDecay);
        mAmpEnv.setSustain(params.ampSustain);
        mAmpEnv.setRelease(params.ampRelease);

        mFiltEnv.setAttack(params.filtAttack);
        mFiltEnv.setDecay(params.filtDecay);
        mFiltEnv.setSustain(params.filtSustain);
        mFiltEnv.setRelease(params.filtRelease);

        // Update envelope B parameters
        mAmpEnvB.setAttack(params.ampBAttack);
        mAmpEnvB.setDecay(params.ampBDecay);
        mAmpEnvB.setSustain(params.ampBSustain);
        mAmpEnvB.setRelease(params.ampBRelease);

        mFiltEnvB.setAttack(params.filtBAttack);
        mFiltEnvB.setDecay(params.filtBDecay);
        mFiltEnvB.setSustain(params.filtBSustain);
        mFiltEnvB.setRelease(params.filtBRelease);

        // Set oscillator waveforms
        mOscA.setWaveform(params.oscAWaveform);
        mOscB.setWaveform(params.oscBWaveform);

        // Set filter A topology, slope, type, and resonance
        mFilter.setTopology(params.filterTopology);
        mFilter.setOrder(params.filterSlope + 1);    // param 0-3 → order 1-4
        mFilter.setType(params.filterType);
        mFilter.setResonance(params.filterResonance);

        // Set filter B topology, slope, type, and resonance
        mFilterB.setTopology(params.filterBTopology);
        mFilterB.setOrder(params.filterBSlope + 1);
        mFilterB.setType(params.filterBType);
        mFilterB.setResonance(params.filterBResonance);

        // Calculate base frequency from MIDI note + octave + tuning + pitch bend + MPE bend + detune + character drift + microtonal
        float microtonalCents = (params.tuningTableCents && mNoteNumber >= 0 && mNoteNumber < 128)
            ? params.tuningTableCents[mNoteNumber] : 0.0f;
        float charTuningSemitones = (mCharTuningCents + microtonalCents) / 100.0f;
        float totalBend = params.pitchBendSemitones + params.mpePitchBendST;
        float noteFreq = midiNoteToFrequency(
            static_cast<float>(mNoteNumber)
            + static_cast<float>(params.oscAOctave) * 12.0f  // octave → semitones
            + params.oscACoarseTune
            + params.oscAFineTune / 100.0f
            + totalBend
            + detuneOffset
            + charTuningSemitones
        );
        float normFreqA = noteFreq / static_cast<float>(mSampleRate);

        float noteFreqB = midiNoteToFrequency(
            static_cast<float>(mNoteNumber)
            + static_cast<float>(params.oscBOctave) * 12.0f  // octave → semitones
            + params.oscBCoarseTune
            + params.oscBFineTune / 100.0f
            + totalBend
            + detuneOffset
            + charTuningSemitones
        );
        float normFreqB = noteFreqB / static_cast<float>(mSampleRate);

        // Velocity scaling
        float velScale = 1.0f - params.velocitySensitivity * (1.0f - mVelocity);

        // Dual VCA blend mixer: t in [-1,1] → full A at -1, 50/50 at 0, full B at +1
        float t = std::clamp(params.oscBlend, -1.0f, 1.0f);
        float blendB = (t + 1.0f) * 0.5f;
        float blendA = 1.0f - blendB;

        // Determine which chains are audible — skip oscillator + filter if silent
        const bool chainAActive = (blendA * params.oscALevel > 0.0001f);
        const bool chainBActive = (blendB * params.oscBLevel > 0.0001f);

        // Render oscillators into pre-allocated scratch buffers
        int frames = std::min(frameCount, kMaxFrames);
        memset(mBufA, 0, sizeof(float) * frames);
        memset(mBufB, 0, sizeof(float) * frames);

        // Apply MPE Y/Z axis modulation to destinations
        // Destinations: 0=filterCut, 1=ampEnvAmt, 2=oscAShape, 3=oscBShape, 4=lfo1Depth
        float mpeShapeAOffset = 0.0f, mpeShapeBOffset = 0.0f;
        float mpeCutoffOffset = 0.0f;
        auto applyMPEAxis = [&](float value, int dest, float amount) {
            float mod = value * amount;
            switch (dest) {
                case 0: mpeCutoffOffset += mod * 4.0f; break;    // filter cutoff, in octaves (+4 at full)
                case 1: break; // ampEnvAmt — handled elsewhere if needed
                case 2: mpeShapeAOffset += mod * 0.5f; break;    // oscAShape
                case 3: mpeShapeBOffset += mod * 0.5f; break;    // oscBShape
                case 4: break; // lfo1Depth — handled at kernel level
                default: break;
            }
        };
        applyMPEAxis(params.mpePressure, params.mpeYDest, params.mpeYAmount);
        applyMPEAxis(params.mpeSlide, params.mpeZDest, params.mpeZAmount);

        // Only render oscillators that contribute to output
        if (chainAActive) {
            float shapeA = std::clamp(params.oscAShapeMod + mCharShapeOffset + mpeShapeAOffset, 0.0f, 1.0f);
            mOscA.render(normFreqA, shapeA, mBufA, frames);
        }
        if (chainBActive) {
            float shapeB = std::clamp(params.oscBShapeMod + mCharShapeOffset + mpeShapeBOffset, 0.0f, 1.0f);
            mOscB.render(normFreqB, shapeB, mBufB, frames);
        }

        // All cutoff modulation is applied in octave space (multiplicative) so a
        // given amount sounds the same whether the base cutoff is 200 Hz or 8 kHz.
        // Key tracking: 1.0 = 100% (cutoff follows the keyboard 1:1 in pitch).
        float keyTrackOct = params.filterKeyTracking * (static_cast<float>(mNoteNumber) - 60.0f) / 12.0f;

        // Set filter cutoffs once per block (avoid per-sample tanf()) — skip if chain inactive
        if (chainAActive) {
            float filtEnvAStart = mFiltEnv.value();
            float cutoffA = params.filterCutoff
                * exp2f(params.filterEnvAmount * filtEnvAStart * 6.0f   // env: ±6 octaves at full
                        + keyTrackOct + mpeCutoffOffset)
                * mCharFilterMul;
            cutoffA = std::clamp(cutoffA, 20.0f, 20000.0f);
            mFilter.setCutoff(cutoffA);
        }

        if (chainBActive) {
            float filtEnvBStart = mFiltEnvB.value();
            float cutoffB = params.filterBCutoff
                * exp2f(params.filterBEnvAmount * filtEnvBStart * 6.0f
                        + keyTrackOct + mpeCutoffOffset)
                * mCharFilterMul;
            cutoffB = std::clamp(cutoffB, 20.0f, 20000.0f);
            mFilterB.setCutoff(cutoffB);
        }

        for (int i = 0; i < frames; ++i) {
            // Osc A chain: always advance envelope, only process audio if audible
            float sampleA = 0.0f;
            float ampEnvAVal = mAmpEnv.process();
            mFiltEnv.process();
            if (chainAActive) {
                sampleA = mBufA[i] * params.oscALevel;
                sampleA *= ampEnvAVal * velScale * params.oscMasterLevel;
                sampleA = mFilter.process(sampleA);
            }

            // Osc B chain: always advance envelope, only process audio if audible
            float sampleB = 0.0f;
            float ampEnvBVal = mAmpEnvB.process();
            mFiltEnvB.process();
            if (chainBActive) {
                sampleB = mBufB[i] * params.oscBLevel;
                sampleB *= ampEnvBVal * velScale * params.oscMasterLevel;
                sampleB = mFilterB.process(sampleB);
            }

            // Dual VCA blend mixer → output (with character gain offset)
            output[i] += (sampleA * blendA + sampleB * blendB) * mCharGainLinear;

            // Voice done when both amp envelopes are idle
            if (!mAmpEnv.isActive() && !mAmpEnvB.isActive()) {
                mActive = false;
                mNoteNumber = -1;
                mFilter.reset();
                mFilterB.reset();
                break;
            }
        }
    }

private:
    static float midiNoteToFrequency(float note) {
        return 440.0f * exp2f((note - 69.0f) / 12.0f);
    }

    double mSampleRate = 48000.0;
    bool mActive = false;
    int mNoteNumber = -1;
    float mVelocity = 0.0f;
    uint64_t mNoteOnTimestamp = 0;

    SynthOscillator mOscA;
    SynthOscillator mOscB;
    ADSREnvelope mAmpEnv;
    ADSREnvelope mFiltEnv;
    PolyFilter mFilter;
    ADSREnvelope mAmpEnvB;
    ADSREnvelope mFiltEnvB;
    PolyFilter mFilterB;

    // Pre-allocated oscillator scratch buffers (replaces per-call VLAs)
    static constexpr int kMaxFrames = 1024;
    float mBufA[kMaxFrames] = {};
    float mBufB[kMaxFrames] = {};

    // Per-voice character offsets (analog drift)
    float mCharTuningCents = 0.0f;
    float mCharFilterMul   = 1.0f;   // multiplicative offset on filter cutoff
    float mCharShapeOffset = 0.0f;
    float mCharGainLinear  = 1.0f;   // linear gain multiplier
};
