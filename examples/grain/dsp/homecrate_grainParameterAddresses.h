//
//  homecrate_grainParameterAddresses.h
//  homecrate grain
//
//  NEVER renumber: addresses persist in saved projects via fullState.
//  Gaps between clusters are deliberate room for growth.
//

#pragma once

#include <cstdint>

enum homecrate_grainParameterAddress : uint64_t {
    inputGain       = 0,    // 0–4 linear, default 1
    outputGain      = 1,    // 0–4 linear, default 1
    driveAmount     = 2,    // 0–1 tanh saturation (vocal inline), default 0
    dryLevel        = 3,    // 0–1 dry at the FINAL sum only (capture tap and
                            // sends stay pre-fader) — 0 = full texture, no dry
                            // (Bad Mood DRY KILL). Default 1 = passthrough.

    // ── Capture / micro-looper (10–18; 19 reserved) ───────────────────────────
    captureMode     = 10,   // 0 Live / 1 Catch
    catchTrigger    = 11,   // momentary toggle: latch/release the last loopLength
    freezeHold      = 12,   // latching: halt ring writes (infinite hold)
    loopLength      = 13,   // 0.25–5.0 s (catch span; also the live display window)
    loopSync        = 14,   // beat-quantize the catch length
    loopDivision    = 15,   // 0–4: 1/2, 1, 2, 4, 8 beats
    loopOverdub     = 16,   // keep writing into the latched loop (moment stack) [PRO]
    loopFade        = 17,   // 0–1 decay per pass while overdubbing (0 = infinite stack)
    captureSource   = 18,   // 0 Input / 1 Input+FX / 2 FX only

    // ── Grain engine (30–44; 45–49 reserved) ──────────────────────────────────
    grainMix        = 30,   // 0–1 grain bus level — THE gate, default 0
    grainSize       = 31,   // 20–500 ms
    grainDensity    = 32,   // 2–80 grains/s
    grainSpray      = 33,   // 0–1 spawn-position scatter
    grainPitch      = 34,   // −24…+24 st
    grainPitchQuant = 35,   // snap to {0, ±7, ±12, ±24}
    grainPitchRand  = 36,   // 0–1 per-grain random pitch
    grainReverse    = 37,   // 0–1 reverse probability
    grainSpread     = 38,   // 0–1 stereo pan scatter
    grainShape      = 39,   // 0 Hann / 1 Triangle / 2 Decay / 3 Swell
    grainFeedback   = 40,   // 0–0.9 grain wet → ring regeneration
    grainScan       = 41,   // −2…+2 frozen-playhead speed
    grainClock      = 42,   // 0 Full / 1 −5th / 2 −Oct / 3 −2Oct (repitch + degrade)
    crossTarget     = 43,   // 0 Off / 1 Density / 2 Pitch / 3 Size / 4 Spray
    crossAmount     = 44,   // 0–1 input-envelope modulation depth
    grainTone       = 45,   // 0.5 neutral; left = LP darken (12k→400 Hz),
                            // right = HP thin (40→4k Hz). Filters the grain
                            // bus pre-send, so delayed grains inherit it.
    midiMode        = 46,   // 0 Off / 1 Play (held notes gate + pitch the
                            // grains — melodic sampler over the buffer) /
                            // 2 Root (last note re-roots the cloud, latching)
    midiRoot        = 47,   // root MIDI note for both modes, default 60 (C4)
    midiAttack      = 48,   // ms — per-note fade-in of the played layer (Play mode)
    midiRelease     = 49,   // ms — per-note ring-out after key release; grains
                            // keep spawning at decaying level until it dies
                            // (UI labels this DECAY)

    // ── Delay send (50–61; vocal cluster semantics where they carry over) ─────
    delayTime       = 50,   // 20–2000 ms
    delayFeedback   = 51,   // 0–1
    delayTone       = 52,   // 0–1 in-loop damping
    delayLevel      = 53,   // 0–1 wet RETURN level (send/return) — the gate
    delaySync       = 54,
    delayDivision   = 55,   // 0–6 (shared 7-division table)
    delayPingPong   = 56,
    delayTape       = 57,
    delayDuck       = 58,
    delaySend       = 59,   // 0 Input / 1 Grains / 2 Input+Grains
    delayRoute      = 60,   // 0 Out / 1 →Reverb / 2 →Ring / 3 →Wash
    delayOscillate  = 61,   // momentary runaway (engine kOscFeedback, tanh-bounded)

    // ── Reverb (70–75) ────────────────────────────────────────────────────────
    reverbDecay     = 70,   // 0–1 → feedback 0.70 + 0.27·d (vocal mapping)
    reverbBlend     = 71,   // 0–1 wet RETURN level — the gate
    reverbSize      = 72,   // 0.5–2
    reverbPreDelay  = 73,   // 0–100 ms
    reverbTone      = 74,   // 0–1 → cutoff 1500·6^t (vocal mapping)
    reverbDryFeed   = 75,   // 0–1 dry into the reverb send (plain-reverb use)

    // ── Wash / glue (80–83) ───────────────────────────────────────────────────
    washAmount      = 80,   // 0–1 lofi macro (crush+noise+transmit curve) [PRO]
    washWarble      = 81,   // 0–1 tape wow on the wet bus [PRO]
    washMode        = 82,   // 0 Tape / 1 AM Radio / 2 Broken
    glueAmount      = 83,   // 0–1 end-of-chain saturator

    // ── User-assignable MIDI CC numbers (90–92; delayOscCC precedent) ─────────
    catchCC         = 90,   // default 24
    freezeCC        = 91,   // default 25
    oscillateCC     = 92,   // default 27

    // ── Resonator (100–108; SMR-inspired quantized 6-band, 109 reserved) ──────
    resMix          = 100,  // 0–1 wet level into the bus — the gate, default 0
    resQ            = 101,  // 0 broad … 1 long ringing
    resRotate       = 102,  // 0–1 = one full lap of the enabled-key ring
    resSpread       = 103,  // 0–1 → 0…4 extra ring steps between bands
    keyMask         = 104,  // GLOBAL 12-bit pitch-class mask (chassis keybed).
                            // Drives the resonator ring, grain pitch-quantize,
                            // and MIDI input (notes quantize UP to enabled keys).
    resRoot         = 105,  // MIDI note of the ring bottom, default 40 (E2)
    resMorph        = 106,  // 0–1 → 5 ms…2 s per-band frequency glide
    resBandMask     = 107,  // 6-bit per-band enable, default 63
    resSend         = 108,  // 0 Input / 1 Grains / 2 Input+Grains, default 2

    // ── Resonator LFO (110–115; vocal lofi-LFO pattern, block-rate) ───────────
    resLfoTarget    = 110,  // 0 Off / 1 Rotate / 2 Spread / 3 Q / 4 Morph / 5 Mix / 6 Root
    resLfoRate      = 111,  // 0.05–8 Hz (free-running)
    resLfoSync      = 112,  // beat-rate lock via resLfoDivision
    resLfoDivision  = 113,  // 0–6, shared 7-division table
    resLfoShape     = 114,  // 0 Sine / 1 Tri / 2 Saw+ / 3 Saw− / 4 Square / 5 S&H
    resLfoDepth     = 115,  // 0–1 — the gate (with target Off)

    // ── Grain LFO (120–125; spawn-time application, inherently zipper-free) ───
    grainLfoTarget  = 120,  // 0 Off / 1 Size / 2 Density / 3 Spray / 4 Pitch
                            // (pre-quantize → stays in key) / 5 Spread / 6 Scan / 7 Tone
    grainLfoRate    = 121,  // 0.05–8 Hz
    grainLfoSync    = 122,
    grainLfoDivision = 123, // 0–6
    grainLfoShape   = 124,  // 0–5
    grainLfoDepth   = 125,  // 0–1 — the gate
};
