/**
 * Block-rate evaluation of parameter-only subtrees.
 *
 * A coefficient calculation rooted in parameters has the same answer for
 * every sample in a block, and in a plugin-sized graph most of the node count
 * is exactly that. Computing it once per block instead of once per sample per
 * channel is invisible in the output, which is the point and also the danger:
 * the two ways it can go wrong are hoisting something that is not constant
 * (stale audio) and failing to invalidate when a parameter moves (a knob that
 * does nothing). Both are covered here, and the golden-audio snapshot covers
 * the third, that nothing about the rendered signal changed at all.
 */
import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../src/asl/compile';
import { ASL } from '../../src/asl/graph';
import { audio, delay, env, filter, lfo, osc, sampleHold, select, uniform } from '../../src/asl/builders';

const SR = 48000;

function render(voice: ReturnType<typeof compileVoice>, state: ReturnType<ReturnType<typeof compileVoice>['createState']>, frames: number, input?: Float32Array) {
  const out = new Float32Array(frames);
  voice.renderBlock(state, SR, out, input);
  return out;
}

describe('block-constant subtrees', () => {
  it('hoists arithmetic over parameters', () => {
    const voice = compileVoice(ASL.node(({ input, gain, trim }) => input.mul(gain.mul(trim).add(0.5))));
    // gain, trim, their product, the add, and the constants either side.
    expect(voice.blockConstantNodes).toBeGreaterThan(0);
  });

  it('hoists nothing in a graph whose every node touches the signal', () => {
    const voice = compileVoice(ASL.node(({ input }) => filter.lowpass(input, { cutoff: 800, q: 0.7 })));
    // The cutoff and q constants are block constant on their own; the filter
    // and the port are not. What matters is that the filter is not.
    const all = compileVoice(ASL.node(({ input }) => input));
    expect(all.blockConstantNodes).toBe(0);
    expect(voice.blockConstantNodes).toBeLessThan(4);
  });

  it('leaves stateful nodes on the sample path even when their inputs are constant', () => {
    // Every input here is a constant, so a purely structural analysis would
    // hoist the lot and the oscillator would emit one number forever.
    for (const build of [
      () => osc({ freq: uniform(440), type: 'saw' }),
      () => lfo({ rate: uniform(200) }),
      () => sampleHold(osc({ freq: uniform(300) }), { freq: uniform(1000) }),
      () => delay(osc({ freq: uniform(220) }), { timeSec: 0.001, feedback: 0.3, mix: 1 }),
      () => env.dahdsr({ attack: 0.001, decay: 0.01, sustain: 0.5, release: 0.1 }),
    ]) {
      const voice = compileVoice(ASL.node(build));
      const state = voice.createState();
      voice.noteOn(state, {});
      const block = render(voice, state, 256);
      const first = block[0]!;
      expect(block.some((sample) => sample !== first), 'a hoisted stateful node would be flat').toBe(true);
    }
  });

  it('does not hoist the channel index, which differs between the two passes', () => {
    const voice = compileVoice(
      ASL.node(({ input }) => select(input.mul(0.25), input.mul(1), { which: audio.lane() })),
    );
    const state = voice.createState();
    voice.noteOn(state, {});
    const left = new Float32Array(8);
    const right = new Float32Array(8);
    const inputL = Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1]);
    voice.renderBlock(state, SR, left, inputL, { inputR: inputL, outputR: right });
    expect(left[0]).toBeCloseTo(0.25, 6);
    expect(right[0]).toBeCloseTo(1, 6);
  });

  it('recomputes when a parameter moves between blocks', () => {
    const voice = compileVoice(ASL.node(({ input, gain }) => input.mul(gain.mul(2))));
    const state = voice.createState();
    voice.noteOn(state, { gain: 0.5 });
    const ones = Float32Array.from([1, 1, 1, 1]);
    expect(render(voice, state, 4, ones)[0]).toBeCloseTo(1, 6);

    state.params.gain = 0.25;
    expect(render(voice, state, 4, ones)[0]).toBeCloseTo(0.5, 6);

    voice.noteOn(state, { gain: 1 });
    expect(render(voice, state, 4, ones)[0]).toBeCloseTo(2, 6);
  });

  it('recomputes on every call of the per-sample path, where a parameter can move at any time', () => {
    const voice = compileVoice(ASL.node(({ gain }) => gain.mul(2)));
    const state = voice.createState();
    voice.noteOn(state, { gain: 1 });
    expect(voice.renderSample(state, SR)).toBeCloseTo(2, 6);
    state.params.gain = 3;
    expect(voice.renderSample(state, SR)).toBeCloseTo(6, 6);
  });

  it('reports a large share of a plugin-sized parameter tree', () => {
    // The shape the optimisation exists for: a pile of coefficient
    // arithmetic wrapped around a little signal path.
    const voice = compileVoice(
      ASL.node(({ input, a, b, c }) => {
        const curve = a.mul(b).add(c.mul(0.5)).mul(a.add(b));
        const q = c.mul(-1.9).add(2).mul(a.add(1));
        return filter.lowpass(input.mul(curve), { cutoff: q.mul(1000).add(200), q: 0.7 });
      }),
    );
    expect(voice.blockConstantNodes).toBeGreaterThanOrEqual(12);
  });
});
