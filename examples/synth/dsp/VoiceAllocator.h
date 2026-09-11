//
//  VoiceAllocator.h
//  homecrate synth
//
//  Manages polyphonic voice allocation and monophonic note stacking.
//
//  Poly mode:  Configurable voice stealing and priority modes.
//  Mono mode:  All notes route to voice 0 with last-note-priority legato.
//              Up to 6 unison sub-voices with detune spread.
//

#pragma once

#include "SynthVoice.h"
#include <algorithm>
#include <cstring>
#include <cstdlib>

// Voice stealing strategy when all poly voices are active
enum class VoiceStealMode : int {
    OldestNote    = 0,  // steal the oldest sounding note (default)
    LowestNote    = 1,  // steal the lowest pitch
    HighestNote   = 2,  // steal the highest pitch
    LowestVelocity = 3, // steal the quietest note
    RoundRobin    = 4,  // cycle through voices in order
    Random        = 5,  // pseudo-random voice selection
    ClosestPitch  = 6,  // steal voice playing closest pitch to new note
};

// Voice priority determines behavior when all voices are active
enum class VoicePriority : int {
    LastNote  = 0,  // new notes always get a voice (default)
    FirstNote = 1,  // held notes protected; new note dropped if no idle voice
    HighNote  = 2,  // only steal if new note is higher than lowest active
    LowNote   = 3,  // only steal if new note is lower than highest active
};

// Lock-free display state for UI voice monitor (written by audio thread, read by UI)
struct VoiceDisplayState {
    int   noteNumber = -1;    // -1 if idle
    float amplitude  = 0.0f;  // current amp env value (0–1)
    int   envStage   = 0;     // 0=idle, 1=attack, 2=decay, 3=sustain, 4=release
    bool  active     = false;
};

class VoiceAllocator {
public:
    static constexpr int kMaxVoices = 8;
    static constexpr int kMaxUnison = 6;
    static constexpr int kNoteStackSize = 16;

    VoiceAllocator() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        for (int i = 0; i < kMaxVoices; ++i) {
            mVoices[i].init(sampleRate);
        }
        for (int i = 0; i < kMaxUnison; ++i) {
            mUnisonVoices[i].init(sampleRate);
        }
        mNoteStackCount = 0;
        mTimestamp = 0;
        mGlideTarget = -1;
        mGlideNote = -1.0f;
        mRoundRobinIdx = 0;
    }

    // ---- MPE per-voice state ----

    struct MPEVoiceState {
        int  midiChannel          = -1;
        float pitchBendSemitones  = 0.0f;
        float pressure            = 0.0f;  // Y-axis (channel pressure)
        float slide               = 0.0f;  // Z-axis (CC74)
    };

    // Assign MPE channel to voice on noteOn (called from kernel MIDI handler)
    void setMPEChannel(int voiceIdx, int channel) {
        if (voiceIdx >= 0 && voiceIdx < kMaxVoices)
            mMPEState[voiceIdx].midiChannel = channel;
    }

    // Find which voice is assigned to an MPE channel
    int findVoiceForChannel(int channel) const {
        for (int i = 0; i < kMaxVoices; ++i) {
            if (mVoices[i].isActive() && mMPEState[i].midiChannel == channel)
                return i;
        }
        return -1;
    }

    void setMPEPitchBend(int channel, float semitones) {
        int v = findVoiceForChannel(channel);
        if (v >= 0) mMPEState[v].pitchBendSemitones = semitones;
    }

    void setMPEPressure(int channel, float value) {
        int v = findVoiceForChannel(channel);
        if (v >= 0) mMPEState[v].pressure = value;
    }

    void setMPESlide(int channel, float value) {
        int v = findVoiceForChannel(channel);
        if (v >= 0) mMPEState[v].slide = value;
    }

    const MPEVoiceState& getMPEState(int voiceIdx) const { return mMPEState[voiceIdx]; }

    void setStealMode(int mode) { mStealMode = static_cast<VoiceStealMode>(std::clamp(mode, 0, 6)); }
    void setPriority(int prio) { mPriority = static_cast<VoicePriority>(std::clamp(prio, 0, 3)); }

    void setCharacterParams(float tuningDrift, float filterSpread, float shapeSpread, float gainSpread, int seed) {
        bool changed = (tuningDrift != mCharTuningDrift || filterSpread != mCharFilterSpread ||
                        shapeSpread != mCharShapeSpread || gainSpread != mCharGainSpread ||
                        seed != mCharSeed);
        mCharTuningDrift  = tuningDrift;
        mCharFilterSpread = filterSpread;
        mCharShapeSpread  = shapeSpread;
        mCharGainSpread   = gainSpread;
        mCharSeed         = seed;
        if (changed) mCharParamsDirty = true;
    }

    // Re-apply character to all active poly voices when spreads or seed change.
    void refreshCharacterForActiveVoices(int maxVoices) {
        if (!mCharParamsDirty) return;
        mCharParamsDirty = false;
        for (int i = 0; i < maxVoices; ++i) {
            if (mVoices[i].isActive()) {
                applyCharacter(i);
            }
        }
    }

    // ---- Poly mode ----

    void polyNoteOn(int note, float velocity, int maxVoices) {
        mTimestamp++;

        // First try to find an idle voice
        for (int i = 0; i < maxVoices; ++i) {
            if (!mVoices[i].isActive()) {
                mVoices[i].noteOn(note, velocity, mTimestamp);
                applyCharacter(i);
                return;
            }
        }

        // All voices active — apply priority check
        switch (mPriority) {
            case VoicePriority::FirstNote:
                return; // drop the new note
            case VoicePriority::HighNote: {
                // Only steal if new note is higher than the lowest active note
                int lowestNote = 127;
                for (int i = 0; i < maxVoices; ++i)
                    if (mVoices[i].isActive()) lowestNote = std::min(lowestNote, mVoices[i].noteNumber());
                if (note <= lowestNote) return; // drop
                break;
            }
            case VoicePriority::LowNote: {
                // Only steal if new note is lower than the highest active note
                int highestNote = 0;
                for (int i = 0; i < maxVoices; ++i)
                    if (mVoices[i].isActive()) highestNote = std::max(highestNote, mVoices[i].noteNumber());
                if (note >= highestNote) return; // drop
                break;
            }
            default:
                break; // LastNote: always proceed to steal
        }

        // Select which voice to steal based on steal mode
        int victim = selectVictim(note, maxVoices);
        mVoices[victim].noteOn(note, velocity, mTimestamp);
        applyCharacter(victim);
    }

    void polyNoteOff(int note) {
        for (int i = 0; i < kMaxVoices; ++i) {
            if (mVoices[i].isActive() && mVoices[i].noteNumber() == note && !mVoices[i].isReleasing()) {
                mVoices[i].noteOff();
                return;
            }
        }
    }

    // ---- Mono mode ----

    void monoNoteOn(int note, float velocity, int unisonCount) {
        mTimestamp++;

        // Push to note stack
        if (mNoteStackCount < kNoteStackSize) {
            mNoteStack[mNoteStackCount] = note;
            mNoteVelocities[mNoteStackCount] = velocity;
            mNoteStackCount++;
        }

        // Trigger unison voices on the new note
        int count = std::min(unisonCount, kMaxUnison);
        for (int i = 0; i < count; ++i) {
            mUnisonVoices[i].noteOn(note, velocity, mTimestamp);
        }

        mGlideTarget = note;
    }

    void monoNoteOff(int note) {
        // Remove from note stack
        for (int i = 0; i < mNoteStackCount; ++i) {
            if (mNoteStack[i] == note) {
                // Shift remaining notes down
                for (int j = i; j < mNoteStackCount - 1; ++j) {
                    mNoteStack[j] = mNoteStack[j + 1];
                    mNoteVelocities[j] = mNoteVelocities[j + 1];
                }
                mNoteStackCount--;
                break;
            }
        }

        if (mNoteStackCount > 0) {
            // Legato: retrigger on the top of the stack
            int topNote = mNoteStack[mNoteStackCount - 1];
            float topVel = mNoteVelocities[mNoteStackCount - 1];
            for (int i = 0; i < kMaxUnison; ++i) {
                if (mUnisonVoices[i].isActive()) {
                    mUnisonVoices[i].noteOn(topNote, topVel, mTimestamp);
                }
            }
            mGlideTarget = topNote;
        } else {
            // All notes released
            for (int i = 0; i < kMaxUnison; ++i) {
                mUnisonVoices[i].noteOff();
            }
            mGlideTarget = -1;
        }
    }

    // ---- Rendering ----

    void renderPoly(float* output, int frameCount, const SynthVoiceParams& params, int maxVoices) {
        for (int i = 0; i < maxVoices; ++i) {
            if (!mVoices[i].isActive()) continue;
            // Copy params and apply per-voice MPE modulation
            SynthVoiceParams vp = params;
            vp.mpePitchBendST = mMPEState[i].pitchBendSemitones;
            vp.mpePressure    = mMPEState[i].pressure;
            vp.mpeSlide       = mMPEState[i].slide;
            mVoices[i].render(output, frameCount, vp);
        }
        // Update display state after render
        updateDisplayStates(maxVoices);
    }

    void renderMono(float* output, int frameCount, const SynthVoiceParams& params,
                    int unisonCount, float detuneSpread, const float* unisonShapes) {
        int count = std::min(unisonCount, kMaxUnison);

        for (int i = 0; i < count; ++i) {
            // Calculate detune offset for this unison voice
            float detuneOffset = 0.0f;
            if (count > 1) {
                // Spread voices evenly from -detuneSpread to +detuneSpread (in semitones)
                float maxDetuneSemitones = detuneSpread * 0.5f;  // 0..0.5 semitones
                float position = static_cast<float>(i) / static_cast<float>(count - 1);  // 0..1
                detuneOffset = (position * 2.0f - 1.0f) * maxDetuneSemitones;
            }

            // Use per-voice shape if provided
            SynthVoiceParams voiceParams = params;
            if (unisonShapes) {
                voiceParams.oscAShapeMod = unisonShapes[i];
            }

            mUnisonVoices[i].render(output, frameCount, voiceParams, detuneOffset);
        }
    }

    // All-notes-off (panic)
    void allNotesOff() {
        for (int i = 0; i < kMaxVoices; ++i) {
            mVoices[i].noteOff();
        }
        for (int i = 0; i < kMaxUnison; ++i) {
            mUnisonVoices[i].noteOff();
        }
        mNoteStackCount = 0;
        mGlideTarget = -1;
    }

    bool anyVoiceActive(int maxVoices) const {
        for (int i = 0; i < maxVoices; ++i) {
            if (mVoices[i].isActive()) return true;
        }
        for (int i = 0; i < kMaxUnison; ++i) {
            if (mUnisonVoices[i].isActive()) return true;
        }
        return false;
    }

    SynthVoice* voices() { return mVoices; }
    SynthVoice* unisonVoices() { return mUnisonVoices; }

    // ---- Display state (lock-free, for UI polling) ----

    // Public wrapper for updating display states (used when kernel renders voices directly)
    void updateDisplayStatesExternal(int maxVoices) { updateDisplayStates(maxVoices); }

    void getDisplayStates(VoiceDisplayState* outStates, int count) const {
        int n = std::min(count, kMaxVoices);
        for (int i = 0; i < n; ++i) {
            outStates[i] = mDisplayStates[i];
        }
    }

private:
    // Select which voice to steal based on the current steal mode
    int selectVictim(int newNote, int maxVoices) {
        switch (mStealMode) {
            case VoiceStealMode::OldestNote: {
                int victim = 0;
                uint64_t oldestTime = mVoices[0].noteOnTimestamp();
                for (int i = 1; i < maxVoices; ++i) {
                    if (mVoices[i].noteOnTimestamp() < oldestTime) {
                        oldestTime = mVoices[i].noteOnTimestamp();
                        victim = i;
                    }
                }
                return victim;
            }
            case VoiceStealMode::LowestNote: {
                int victim = 0;
                int lowestNote = mVoices[0].noteNumber();
                for (int i = 1; i < maxVoices; ++i) {
                    if (mVoices[i].noteNumber() < lowestNote) {
                        lowestNote = mVoices[i].noteNumber();
                        victim = i;
                    }
                }
                return victim;
            }
            case VoiceStealMode::HighestNote: {
                int victim = 0;
                int highestNote = mVoices[0].noteNumber();
                for (int i = 1; i < maxVoices; ++i) {
                    if (mVoices[i].noteNumber() > highestNote) {
                        highestNote = mVoices[i].noteNumber();
                        victim = i;
                    }
                }
                return victim;
            }
            case VoiceStealMode::LowestVelocity: {
                int victim = 0;
                float lowestVel = mVoices[0].velocity();
                for (int i = 1; i < maxVoices; ++i) {
                    if (mVoices[i].velocity() < lowestVel) {
                        lowestVel = mVoices[i].velocity();
                        victim = i;
                    }
                }
                return victim;
            }
            case VoiceStealMode::RoundRobin: {
                int victim = mRoundRobinIdx % maxVoices;
                mRoundRobinIdx++;
                return victim;
            }
            case VoiceStealMode::Random: {
                // Deterministic from timestamp for reproducibility
                uint32_t h = static_cast<uint32_t>(mTimestamp * 2654435761u);
                return static_cast<int>(h % static_cast<uint32_t>(maxVoices));
            }
            case VoiceStealMode::ClosestPitch: {
                int victim = 0;
                int closestDist = std::abs(mVoices[0].noteNumber() - newNote);
                for (int i = 1; i < maxVoices; ++i) {
                    int dist = std::abs(mVoices[i].noteNumber() - newNote);
                    if (dist < closestDist) {
                        closestDist = dist;
                        victim = i;
                    }
                }
                return victim;
            }
        }
        return 0; // fallback
    }

    // Compute and apply per-voice character offset on note-on
    void applyCharacter(int voiceIdx) {
        // Deterministic pseudo-random from voice index + seed
        uint32_t h = static_cast<uint32_t>(voiceIdx * 2654435761u) ^ static_cast<uint32_t>(mCharSeed * 40503u);
        h ^= h >> 16;
        h *= 0x45d9f3b;
        h ^= h >> 16;
        float norm = static_cast<float>(h & 0xFFFF) / 65535.0f - 0.5f; // -0.5 to +0.5

        float tuningCents  = norm * 16.0f * mCharTuningDrift;            // ±8 cents at max
        float filterMul    = 1.0f + norm * 0.30f * mCharFilterSpread;    // ±15% at max
        float shapeOffset  = norm * 0.30f * mCharShapeSpread;            // ±0.15 at max
        float gainDB       = norm * 4.0f * mCharGainSpread;              // ±2dB at max

        mVoices[voiceIdx].setCharacter(tuningCents, filterMul, shapeOffset, gainDB);
    }

    // Update display states after rendering (called from audio thread)
    void updateDisplayStates(int maxVoices) {
        for (int i = 0; i < maxVoices; ++i) {
            auto& ds = mDisplayStates[i];
            if (mVoices[i].isActive()) {
                ds.noteNumber = mVoices[i].noteNumber();
                ds.amplitude  = mVoices[i].ampEnvValue();
                ds.envStage   = static_cast<int>(mVoices[i].ampEnvStage());
                ds.active     = true;
            } else {
                ds.noteNumber = -1;
                ds.amplitude  = 0.0f;
                ds.envStage   = 0;
                ds.active     = false;
            }
        }
        // Clear unused slots
        for (int i = maxVoices; i < kMaxVoices; ++i) {
            mDisplayStates[i] = {};
        }
    }

    double mSampleRate = 48000.0;
    uint64_t mTimestamp = 0;

    VoiceStealMode mStealMode = VoiceStealMode::OldestNote;
    VoicePriority  mPriority  = VoicePriority::LastNote;
    int mRoundRobinIdx = 0;

    // Character profile params (set from kernel each process block)
    float mCharTuningDrift  = 0.0f;
    float mCharFilterSpread = 0.0f;
    float mCharShapeSpread  = 0.0f;
    float mCharGainSpread   = 0.0f;
    int   mCharSeed         = 0;
    bool  mCharParamsDirty  = false;

    // Poly voices
    SynthVoice mVoices[kMaxVoices];

    // Mono/unison voices
    SynthVoice mUnisonVoices[kMaxUnison];

    // Note stack for mono mode (last-note priority)
    int   mNoteStack[kNoteStackSize] = {};
    float mNoteVelocities[kNoteStackSize] = {};
    int   mNoteStackCount = 0;

    // Glide state
    int   mGlideTarget = -1;
    float mGlideNote = -1.0f;

    // MPE per-voice state
    MPEVoiceState mMPEState[kMaxVoices] = {};

    // Display state (read by UI thread via getDisplayStates)
    VoiceDisplayState mDisplayStates[kMaxVoices] = {};
};
