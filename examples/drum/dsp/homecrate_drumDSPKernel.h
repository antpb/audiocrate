//
//  homecrate_drumDSPKernel.h
//  homecrate drum
//
//  Per-pad bitcrush + filter and master filter + IR convolver.
//  Swift-safe declaration. Method bodies live in homecrate_drumDSPKernel.mm.
//  Heavy DSP types are hidden behind a pimpl so the kernel can be held
//  directly as a Swift property (move-constructible, non-copyable).
//

#pragma once

#import <AudioToolbox/AudioToolbox.h>

class homecrate_drumDSPKernel {
public:
    homecrate_drumDSPKernel();
    ~homecrate_drumDSPKernel();

    // Non-copyable, movable (Swift C++ interop requirement)
    homecrate_drumDSPKernel(const homecrate_drumDSPKernel&) = delete;
    homecrate_drumDSPKernel& operator=(const homecrate_drumDSPKernel&) = delete;
    homecrate_drumDSPKernel(homecrate_drumDSPKernel&& o) noexcept;
    homecrate_drumDSPKernel& operator=(homecrate_drumDSPKernel&&) = delete;

    void initialize(double sampleRate, AUAudioFrameCount maxFrames);
    void deInitialize();

    // Per-pad and master parameter routing. Addresses follow
    // homecrate_drumParameterAddresses.swift (32..99). Out-of-range
    // addresses are silently ignored.
    void setParameter(AUParameterAddress address, AUValue value);

    // Master bypass for the per-pad DSP block. When true,
    // processPadInPlace becomes a no-op.
    void setBypassPadDSP(bool bypass);
    bool isBypassPadDSP() const;

    // IR loading (off-audio-thread). Either synthesize the default character
    // or load a user-provided mono float buffer.
    void synthesizeDefaultMasterIR();
    void setUserMasterIR(const float* samples, int sampleCount);
    void clearMasterIR();

    // ---- Per-render-call surface (audio thread) ----

    // Apply bitcrush + per-pad LPF to a stereo scratch buffer in place.
    void processPadInPlace(int padIdx, float* samplesL, float* samplesR, int frames);

    // Apply master filter + IR mix to the bus in place. Skips entirely if
    // the bus is silent (caller indicates via `busActive`).
    void processMasterBus(float* outL, float* outR, int frames, bool busActive);

private:
    struct Impl;
    Impl* pImpl = nullptr;
};
