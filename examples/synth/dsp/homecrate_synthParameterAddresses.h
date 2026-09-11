//
//  homecrate_synthParameterAddresses.h
//  homecrate synth
//
//  Created by anthony burchell on 4/3/26.
//

#pragma once

#include <cstdint>

enum homecrate_synthParameterAddress : uint64_t {
    // Oscillator Section (10)
    oscAWaveform       = 0,
    oscACoarseTune     = 1,
    oscAFineTune       = 2,
    oscAShapeMod       = 3,
    oscBWaveform       = 4,
    oscBCoarseTune     = 5,
    oscBFineTune       = 6,
    oscBShapeMod       = 7,
    oscBlend           = 8,
    oscMasterLevel     = 9,

    // Amp Envelope (4)
    ampAttack          = 10,
    ampDecay           = 11,
    ampSustain         = 12,
    ampRelease         = 13,

    // Filter Section (4)
    filterType         = 14,
    filterCutoff       = 15,
    filterResonance    = 16,
    filterEnvAmount    = 17,

    // Filter Envelope (4)
    filtAttack         = 18,
    filtDecay          = 19,
    filtSustain        = 20,
    filtRelease        = 21,

    // Voice Mode (5)
    voiceMode          = 22,
    unisonCount        = 23,
    unisonDetune       = 24,
    glideTime          = 25,
    polyVoiceCount     = 26,

    // Bit Crusher / SRR (3)
    crusherMix         = 27,
    crusherBitDepth    = 28,
    crusherSampleRate  = 29,

    // Chorus (3)
    chorusRate         = 30,
    chorusDepth        = 31,
    chorusMix          = 32,

    // Delay (4)
    delaySync          = 33,
    delayFeedback      = 34,
    delayMix           = 35,
    delayTimeMs        = 36,

    // Reverb (4)
    reverbDecay        = 37,
    reverbSize         = 38,
    reverbPreDelay     = 39,
    reverbBlend        = 40,

    // Master (2)
    masterGain         = 41,
    masterPan          = 42,

    // Mono Unison Per-Voice Waveshape (6)
    unisonShape0       = 43,
    unisonShape1       = 44,
    unisonShape2       = 45,
    unisonShape3       = 46,
    unisonShape4       = 47,
    unisonShape5       = 48,

    // Global (3)
    pitchBendRange     = 49,
    velocitySensitivity = 50,
    filterKeyTracking  = 51,

    // LFO 1 (4)
    lfo1Rate           = 52,
    lfo1Depth          = 53,
    lfo1Shape          = 54,
    lfo1Destination    = 55,

    // LFO 2 (4)
    lfo2Rate           = 56,
    lfo2Depth          = 57,
    lfo2Shape          = 58,
    lfo2Destination    = 59,

    // External Audio Pass-Through (3)
    extAudioMode       = 60,   // 0 = off (normal synth), 1 = pass-through
    extVCABypass       = 61,   // 0 = VCA gates signal (MIDI-triggered), 1 = bypass VCA
    extInputGain       = 62,   // 0..2, default 1.0

    // Oscillator Octave (2) — AU value -1..+1 maps to -3..+3 octaves in DSP
    oscAOctave         = 63,
    oscBOctave         = 64,

    // Per-Oscillator B: Amp Envelope (4)
    ampBAttack         = 65,
    ampBDecay          = 66,
    ampBSustain        = 67,
    ampBRelease        = 68,

    // Per-Oscillator B: Filter (4)
    filterBType        = 69,
    filterBCutoff      = 70,
    filterBResonance   = 71,
    filterBEnvAmount   = 72,

    // Per-Oscillator B: Filter Envelope (4)
    filtBAttack        = 73,
    filtBDecay         = 74,
    filtBSustain       = 75,
    filtBRelease       = 76,

    // Link Toggles (3) — 0/1 boolean, default 1 (linked)
    ampEnvLink         = 77,
    filterLink         = 78,
    filtEnvLink        = 79,

    // Per-Oscillator Volume (2) — pre-blend independent levels
    oscALevel          = 80,
    oscBLevel          = 81,

    // Voice Allocation (2)
    voiceStealMode     = 100,  // indexed 0–6: Oldest, Lowest, Highest, Quietest, RoundRobin, Random, ClosestPitch
    voicePriority      = 101,  // indexed 0–3: LastNote, FirstNote, HighNote, LowNote

    // Character Profiles (5) — per-voice analog drift in poly mode
    charTuningDrift    = 110,  // 0–1, at 1.0 = ±8 cents across voices
    charFilterSpread   = 111,  // 0–1, at 1.0 = ±15% cutoff offset
    charShapeSpread    = 112,  // 0–1, at 1.0 = ±0.15 shape offset
    charGainSpread     = 113,  // 0–1, at 1.0 = ±2dB
    charSeed           = 114,  // indexed 0–99, reroll pattern

    // MPE (6)
    mpeEnabled         = 150,  // boolean, default 0
    mpePitchBendRange  = 151,  // 1–96 semitones, default 48
    mpeYAxisDest       = 152,  // indexed 0–4: filterCut, ampEnvAmt, oscAShape, oscBShape, lfo1Depth
    mpeZAxisDest       = 153,  // indexed 0–4
    mpeYAxisAmount     = 154,  // 0–1
    mpeZAxisAmount     = 155,  // 0–1

    // IR Cabinet Slots (5 params × 6 slots = 30)
    // Slot 0 (Osc A / Unison V1)
    irSlot0Active      = 250,  // boolean, default 0
    irSlot0Gain        = 251,  // 0–2, default 1.0
    irSlot0EQBand0     = 252,  // -12..+12 dB, low shelf 80Hz
    irSlot0EQBand1     = 253,  // -12..+12 dB, mid peak 800Hz
    irSlot0EQBand2     = 254,  // -12..+12 dB, high shelf 8kHz
    // Slot 1 (Osc B / Unison V2)
    irSlot1Active      = 255,
    irSlot1Gain        = 256,
    irSlot1EQBand0     = 257,
    irSlot1EQBand1     = 258,
    irSlot1EQBand2     = 259,
    // Slot 2 (Unison V3)
    irSlot2Active      = 260,
    irSlot2Gain        = 261,
    irSlot2EQBand0     = 262,
    irSlot2EQBand1     = 263,
    irSlot2EQBand2     = 264,
    // Slot 3 (Unison V4)
    irSlot3Active      = 265,
    irSlot3Gain        = 266,
    irSlot3EQBand0     = 267,
    irSlot3EQBand1     = 268,
    irSlot3EQBand2     = 269,
    // Slot 4 (Unison V5)
    irSlot4Active      = 270,
    irSlot4Gain        = 271,
    irSlot4EQBand0     = 272,
    irSlot4EQBand1     = 273,
    irSlot4EQBand2     = 274,
    // Slot 5 (Unison V6)
    irSlot5Active      = 275,
    irSlot5Gain        = 276,
    irSlot5EQBand0     = 277,
    irSlot5EQBand1     = 278,
    irSlot5EQBand2     = 279,

    // Arpeggiator (33) — runs entirely in Swift; DSP just stores the values
    // so presets round-trip. No render-loop hooks.
    arpEnabled         = 280,  // boolean, default 0
    arpMode            = 281,  // indexed 0–2: Hold, Chord, Sequence
    arpRate            = 282,  // indexed 0–6: 1/4, 1/4T, 1/8, 1/8T, 1/16, 1/16T, 1/32
    arpGate            = 283,  // 0.05–1.0, default 0.5
    arpDirection       = 284,  // indexed 0–3: Up, Down, UpDown, Random
    arpOctaveRange     = 285,  // 1–4
    arpChordRandomize  = 286,  // boolean
    arpLatch           = 287,  // boolean
    arpStepCount       = 288,  // 1–8
    arpStep0Enabled    = 289,
    arpStep1Enabled    = 290,
    arpStep2Enabled    = 291,
    arpStep3Enabled    = 292,
    arpStep4Enabled    = 293,
    arpStep5Enabled    = 294,
    arpStep6Enabled    = 295,
    arpStep7Enabled    = 296,
    arpStep0Pitch      = 297,  // 0–11 chromatic within octave
    arpStep1Pitch      = 298,
    arpStep2Pitch      = 299,
    arpStep3Pitch      = 300,
    arpStep4Pitch      = 301,
    arpStep5Pitch      = 302,
    arpStep6Pitch      = 303,
    arpStep7Pitch      = 304,
    arpStep0Octave     = 305,  // -2..+2 octave offset
    arpStep1Octave     = 306,
    arpStep2Octave     = 307,
    arpStep3Octave     = 308,
    arpStep4Octave     = 309,
    arpStep5Octave     = 310,
    arpStep6Octave     = 311,
    arpStep7Octave     = 312,

    // Filter topology / slope
    filterTopology     = 313,   // 0=SVF, 1=Ladder, 2=Cascade
    filterSlope        = 314,   // 0=6dB, 1=12dB, 2=18dB, 3=24dB
    filterBTopology    = 315,
    filterBSlope       = 316,

    // Total parameter count
    synthParamCount    = 317
};
