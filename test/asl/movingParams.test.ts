/**
 * Does moving a parameter click?
 *
 * The golden-audio snapshot and the conformance fixture both render with
 * **fixed** parameters, which is the right way to prove two implementations
 * agree and is structurally blind to this entire class of bug: a node can be
 * perfect at every constant value and produce a click every time the value
 * changes. That is not a corner case, it is what a knob is.
 *
 * The bug this exists for: a delay line computes its read position straight
 * from `timeSec`, so a parameter step moved the pointer to an unrelated part
 * of the buffer and the output leapt. One click per update, and a knob drag
 * is sixty updates a second, so it was heard as continuous crackle that
 * stopped the moment you let go. `comb` had it too, expressed as a frequency.
 *
 * The measurement is deliberately crude and therefore hard to argue with:
 * render the same graph twice, once with the parameter held and once with it
 * stepped at the rate a real control moves, and count sample-to-sample jumps
 * far larger than the signal itself can produce.
 */
import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../src/asl/compile';
import { combMaterial, delayMaterial } from '../../src/materials';
import type { Material } from '../../src/graph/Material';

const SR = 48000;
/** The worklet's render quantum. Params land between blocks, never mid-block. */
const BLOCK = 128;
const BLOCKS = Math.round((1.5 * SR) / BLOCK);
/** A drag emits roughly one setParam per animation frame. */
const BLOCKS_PER_STEP = Math.round(SR / BLOCK / 60);

/**
 * A 220 Hz sine at 0.5 changes by at most ~0.015 per sample, so anything an
 * order of magnitude above that did not come from the signal.
 */
const CLICK = 0.05;

function render(material: Material, param: string, from: number, to: number, move: boolean): Float32Array {
  const voice = compileVoice(material.graph);
  const state = voice.createState();
  for (const [key, value] of Object.entries(material.snapshotParams())) state.params[key] = value;
  state.params[param] = from;
  voice.noteOn(state, {});

  const out = new Float32Array(BLOCKS * BLOCK);
  const input = new Float32Array(BLOCK);
  const block = new Float32Array(BLOCK);
  let phase = 0;
  for (let b = 0; b < BLOCKS; b++) {
    for (let i = 0; i < BLOCK; i++) {
      input[i] = Math.sin((2 * Math.PI * 220 * phase) / SR) * 0.5;
      phase += 1;
    }
    if (move && b % BLOCKS_PER_STEP === 0) {
      const t = Math.min(1, b / (BLOCKS * 0.75));
      state.params[param] = from + (to - from) * t;
    }
    voice.renderBlock(state, SR, block, input, {});
    out.set(block, b * BLOCK);
  }
  return out;
}

function clicks(samples: Float32Array): number {
  let count = 0;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i]! - samples[i - 1]!) > CLICK) count += 1;
  }
  return count;
}

describe('parameters that move', () => {
  it('a swept delay time does not click', () => {
    expect(clicks(render(delayMaterial, 'timeSec', 0.05, 0.25, false))).toBe(0);
    expect(clicks(render(delayMaterial, 'timeSec', 0.05, 0.25, true))).toBe(0);
  });

  it('a swept comb frequency does not click', () => {
    expect(clicks(render(combMaterial, 'freq', 120, 900, false))).toBe(0);
    expect(clicks(render(combMaterial, 'freq', 120, 900, true))).toBe(0);
  });

  it('delay feedback and mix were never the problem, and still are not', () => {
    // Recorded because it is the useful half of the diagnosis: these two
    // parameters are plain multiplications, they were always clean, and
    // chasing them would have been chasing the wrong thing.
    expect(clicks(render(delayMaterial, 'feedback', 0.1, 0.85, true))).toBe(0);
    expect(clicks(render(delayMaterial, 'mix', 0, 1, true))).toBe(0);
  });

  it('a held delay time is unchanged by the glide', () => {
    // The glide takes the target exactly on its first sample, so a delay
    // whose time never moves renders what it always did. That is what lets
    // the golden snapshot stay green through this fix, and it is worth an
    // assertion of its own rather than an inference from one.
    const a = render(delayMaterial, 'timeSec', 0.12, 0.12, false);
    const b = render(delayMaterial, 'timeSec', 0.12, 0.12, true);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
