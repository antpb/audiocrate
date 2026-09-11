//
//  homecrate_ampParameterAddresses.h
//  homecrate amp
//

#pragma once

#include <cstdint>

enum homecrate_ampParameterAddress : uint64_t {
    inputGain      = 0,
    outputGain     = 1,
    // 2 was irBypass — removed (the IR is cleared via the X "unload", not bypassed).
    // Left as a gap so the remaining addresses stay stable for saved-state compatibility.
    eqBand0        = 3,
    eqBand1        = 4,
    eqBand2        = 5,
    eqBand3        = 6,
    eqBand4        = 7,
    reverbDecay    = 8,
    reverbBlend    = 9,
    reverbSize     = 10,
    reverbPreDelay = 11,
    irNormalize    = 12,
    reverbTone     = 13,
    reverbPreAmp   = 14,   // bool: reverb runs BEFORE the NAM (default off = post-amp)
    eqPostAmp      = 15,   // bool: EQ runs AFTER the amp/cab (default off = pre-amp)
    reverbGate     = 16,   // bool: gated-reverb VCA (pre-amp only) keyed off playing dynamics
    stereoMode     = 17,   // bool: independent L/R chains (default off = mono broadcast)
    inputPad       = 18,   // bool: -20 dB input pad for line-level sources (default off)
    invertR        = 19,   // bool: invert right-channel polarity (stereo mode only, default off)
    channelLink    = 20,   // bool: L/R share one NAM profile (default on = today's clone)
    inputGainR     = 21,   // right-channel input gain  (used only when stereo && !volLink)
    outputGainR    = 22,   // right-channel output gain (used only when stereo && !volLink)
    volLink        = 23,   // bool: L/R share input+output gain (default on); independent of channelLink
    delayTime      = 24,   // delay time in ms (20–2000), used when delaySync is off
    delayFeedback  = 25,   // 0–1 repeat feedback (runaway oscillation overrides this while held)
    delayTone      = 26,   // 0–1 in-loop damping: 0 = dark repeats, 1 = bright
    delayMix       = 27,   // 0–1 wet mix (0 = delay fully bypassed)
    delaySync      = 28,   // bool: sync delay time to host BPM via delayDivision
    delayDivision  = 29,   // indexed 0–6: 1/4, 1/8, 1/16, 1/4., 1/8., 1/4T, 1/8T
    delayPingPong  = 30,   // bool: cross-feedback stereo repeats (alternating L/R)
    delayTape      = 31,   // bool: tape mode — wobble + pitch-bending time changes
    delayDuck      = 32,   // bool: repeats duck while playing, bloom in the gaps
    delayPlacement = 33,   // indexed 0–2: 0 = pre-reverb, 1 = post-reverb, 2 = post-amp (chain end)
    delayOscillate = 34,   // bool (momentary): runaway self-oscillation while held / automated
    delayOscCC     = 35,   // MIDI CC number (0–127) that toggles delayOscillate (value >= 64 = on)
    // ── Dynamic morph: crossfade between profile A (mDSP + mConvolver) and
    //    profile B (mDSPR + mConvolverR) driven by the player's own input.
    //    Reuses the second-NAM slot, so morph is mutually exclusive with stereoMode.
    morphEnable      = 36,   // bool: engage dynamic A/B morphing (turns stereoMode off)
    morphSource      = 37,   // indexed 0–1: 0 = Input Dynamics, 1 = Bass Content
    morphDepth       = 38,   // 0–1: how far the detector sweeps the blend (0 = static at morphManual)
    morphThreshold   = 39,   // 0–1: onset floor — where the mapping lifts off profile A
    morphSensitivity = 40,   // 0–1: range/span of the mapping (higher = snappier, narrower span)
    morphAttack      = 41,   // ms: detector attack (default ~5 ms)
    morphRelease     = 42,   // ms: detector release (default ~120 ms)
    morphInvert      = 43,   // bool: swap which profile sits at each end
    morphManual      = 44,   // 0–1: resting/center blend position (bias; = full control at depth 0)
    morphTargetAmp   = 45,   // bool: dynamics drive the AMP (NAM) A↔B blend (default on)
    morphTargetIR    = 46,   // bool: dynamics drive the CAB (IR) A↔B blend (default on)

    // ── VST3-only (not in the AUv3 — keep 47 reserved if iOS adds it) ────────
    // bool: apply the NAM model's input_level_dbu metadata as a pre-gain.
    // Default OFF: desktop DAW DI levels aren't calibrated to the capture's
    // physical level, and the attenuation (-18 dB for an 18.3 dBu model)
    // starves the model into a gate-like response. Matches the official NAM
    // plugin's opt-in calibration default.
    inputCalibration = 47
};
