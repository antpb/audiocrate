/**
 * The resonance transport, rendered offline.
 *
 * `createResonanceAudio` needs an `AudioContext`, `fetch` and `window.THREE`,
 * none of which Node has. But the part worth proving is the one that is *new*
 * relative to a `BufferSource`: arming a `samplePlay` at an offset `P` and then
 * flipping its live `position` param to 0 so the loop wraps to the track start.
 * That is the crate-native stand-in for a BufferSource `offset` + `loop`, and
 * it decides whether a late joiner resumes mid-song and whether the track loops
 * its full length. So this renders that exact sequence through the same
 * interpreter the audio thread runs, and checks the waveform.
 */
import { describe, expect, it } from 'vitest';
import { ASL, samplePlay, tap } from './crate';
import { compileVoice } from '../../../src/asl/compile';

const SR = 8000;
const N = SR;
// A one-second 0→1 ramp. Sample i has value i/(N-1), so its index IS its
// musical position. That makes "what is playing" readable straight off the
// output.
const RAMP = new Float32Array(N);
for (let i = 0; i < N; i++) RAMP[i] = i / (N - 1);

const BOX = { samples: RAMP, sampleRate: SR };

const voice = compileVoice(
  ASL.node(({ position }) => tap.capture(samplePlay({ box: BOX, position, loop: 1 }), { id: 'stem' })),
);

/** Render `count` samples at the current `state.params.position`, returning them. */
function render(count: number, state: ReturnType<typeof voice.createState>): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = voice.renderSample(state, SR);
  return out;
}

describe('resonance arm-at-offset → loop transport', () => {
  it('arms at P, plays P→end, and after the flip loops back to the track start', () => {
    const P = 0.5;
    const state = voice.createState();
    state.params.position = P;
    voice.noteOn(state, {});

    // Phase A: position held at P. Plays the P→end segment only, so the output
    // stays within [P, 1] and never dips toward the track start.
    const phaseA = render(3000, state);
    const aMin = Math.min(...phaseA);
    const aMax = Math.max(...phaseA);
    expect(phaseA[0]).toBeCloseTo(P, 1); // starts at the offset, not at 0
    expect(aMin).toBeGreaterThanOrEqual(P - 0.02);
    expect(aMax).toBeLessThanOrEqual(1);

    // The flip that ARM_HOLD_MS performs: move the loop base back to the start.
    state.params.position = 0;

    // Phase B: the wrap target is now 0, so the output reaches the track start
    // (value 0), which phase A could never produce while looping P→end→P.
    const phaseB = render(2 * N, state);
    const bMin = Math.min(...phaseB);
    expect(bMin).toBeLessThanOrEqual(0.05);
  });

  it('the capture tap carries the playing samples for the FFT analysis path', () => {
    const state = voice.createState();
    state.params.position = 0;
    voice.noteOn(state, {});
    render(1024, state);
    const frame = voice.drainAnalysis(state);
    expect(frame).not.toBeNull();
    const cap = frame!.captures.stem;
    expect(cap.length).toBeGreaterThan(0);
    let nonZero = 0;
    for (const v of cap) if (Math.abs(v) > 1e-4) nonZero++;
    expect(nonZero).toBeGreaterThan(cap.length / 2);
  });

  it('is silent when the gate is off (stop = noteOff)', () => {
    const state = voice.createState();
    state.params.position = 0;
    voice.noteOn(state, {});
    voice.noteOff(state);
    const out = render(256, state);
    let max = 0;
    for (const v of out) max = Math.max(max, Math.abs(v));
    expect(max).toBeLessThan(1e-6);
  });
});
