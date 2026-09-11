//
//  homecrate_synthDSPKernel.h
//  homecrate synth — VST3 port
//
//  Pure-C++ port of the iOS AUv3 DSP kernel. The class/file names and pimpl
//  layout intentionally match the AUv3 tree so the two stay diffable. All
//  AudioToolbox / CoreMIDI dependencies are replaced:
//    - AU parameter/frame types      → plain integer/float typedefs below
//    - AURenderEvent / MIDI2 UMP     → direct note/bend/pressure methods
//    - AUHostMusicalContextBlock     → setHostBPM() fed from ProcessContext
//    - os_unfair_lock                → KernelSpinLock (atomic_flag)
//

#pragma once

#include <cstdint>
#include <atomic>

#include "homecrate_synthParameterAddresses.h"

// AU-compatible type aliases keep the ported kernel body byte-similar to the
// AUv3 implementation.
typedef uint64_t AUParameterAddress;
typedef float    AUValue;
typedef uint32_t AUAudioFrameCount;
typedef int64_t  AUEventSampleTime;

// Try-lockable spinlock standing in for os_unfair_lock (audio thread only
// ever try-locks; loader threads take a full lock).
struct KernelSpinLock {
    std::atomic_flag flag = ATOMIC_FLAG_INIT;
    bool try_lock() { return !flag.test_and_set(std::memory_order_acquire); }
    void lock()     { while (flag.test_and_set(std::memory_order_acquire)) {} }
    void unlock()   { flag.clear(std::memory_order_release); }
};

// C-compatible voice display state for UI polling (8 voices max)
struct SynthVoiceDisplayInfo {
    int   noteNumber;    // -1 if idle
    float amplitude;     // 0–1
    int   envStage;      // 0=idle, 1=attack, 2=decay, 3=sustain, 4=release
    bool  active;
};

class homecrate_synthDSPKernel {
public:
    homecrate_synthDSPKernel();
    ~homecrate_synthDSPKernel();

    homecrate_synthDSPKernel(const homecrate_synthDSPKernel&) = delete;
    homecrate_synthDSPKernel& operator=(const homecrate_synthDSPKernel&) = delete;

    void initialize(int channelCount, double inSampleRate);
    void deInitialize();

    bool isBypassed();
    void setBypass(bool shouldBypass);

    void setParameter(AUParameterAddress address, AUValue value);
    AUValue getParameter(AUParameterAddress address);

    AUAudioFrameCount maximumFramesToRender() const;
    void setMaximumFramesToRender(const AUAudioFrameCount &maxFrames);

    void process(float** outputBuffers, int numChannels, AUEventSampleTime bufferStartTime, AUAudioFrameCount frameCount);
    void processWithInput(const float* const* inputBuffers, int numInputs,
                          float** outputBuffers, int numOutputs,
                          AUEventSampleTime bufferStartTime, AUAudioFrameCount frameCount);

    // ── MIDI surface (called by the VST3 processor on the audio thread) ──
    void triggerNoteOn(int note, float velocity);           // velocity 0..1
    void triggerNoteOff(int note);
    void triggerMPENoteOn(int note, float velocity, int channel);
    // Global pitch bend, normalized -1..1 (scaled by pitchBendRange param).
    void setPitchBendNorm(float norm);
    // MPE per-channel expression, channel 1–15.
    void setMPEPitchBendNorm(int channel, float norm);      // × mpePitchBendRange
    void setMPEPressure(int channel, float pressure);       // 0..1
    void setMPESlide(int channel, float slide);             // 0..1 (CC74)
    void allNotesOff();

    // Host tempo, pushed once per block from the VST3 ProcessContext.
    void setHostBPM(double bpm);
    double currentHostBPM() const;

    // Returns true if any voice is currently producing audio.
    bool anyVoiceActive() const;

    // Copy current voice display states for UI (lock-free read)
    void getVoiceDisplayInfo(SynthVoiceDisplayInfo* outInfo, int count) const;

    // Microtonal: set per-note cents deviation from 12-TET (128 entries)
    void setTuningTable(const float* cents, int count);

    // IR Cabinet: load IR data into a slot (0–5), called off audio thread
    void setIRForSlot(int slotIndex, const float* data, int sampleCount);
    void clearIRForSlot(int slotIndex);

    double mSampleRate = 44100.0;
    bool mBypassed = false;
    AUAudioFrameCount mMaxFramesToRender = 1024;

private:
    void handleMIDINoteOn(unsigned char note, float velocity);
    void handleMPENoteOn(unsigned char note, float velocity, unsigned char channel);
    void handleMIDINoteOff(unsigned char note);

    struct Impl;
    Impl* pImpl = nullptr;

    float mParams[synthParamCount] = {};
    float mTuningTableCents[128] = {};  // per-note cents offset from 12-TET
    std::atomic<double> mHostBPM{120.0};
    float mPitchBendSemitones = 0.0f;
};
