/**
 * The evaluator does two things to stay inside an audio quantum that are
 * only safe because of a property of the graph, not because of a tolerance:
 *
 * 1. It skips the second channel pass when nothing feeding the graph has a
 *    right channel, because the two passes would compute the same block.
 * 2. It reuses filter and follower coefficients until the inputs behind them
 *    move, because recomputing gives back the same doubles.
 *
 * Both are silent when they are wrong: a collapsed stereo image, or a filter
 * that ignores the knob. So the properties are asserted rather than assumed,
 * and the cases that must *not* take the shortcut are asserted too.
 */
import { describe, expect, it } from 'vitest';
import { ASL } from '../../src/asl/graph';
import { audio, compressor, filter, noise, uniform } from '../../src/asl/builders';
import { compileVoice } from '../../src/asl/compile';

const SR = 48000;

function tone(length: number, freq: number, gain = 0.5): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * gain;
  return out;
}

describe('the mono mirror', () => {
  it('skips the right pass when the input is mono, and says so', () => {
    const graph = ASL.node(() => filter.lowpass(audio.input(), { cutoff: uniform(900) }));
    const voice = compileVoice(graph);
    expect(voice.stereo).toBe(true);

    const input = tone(256, 220);
    const outL = new Float32Array(256);
    const outR = new Float32Array(256);
    // No `inputR`: nothing on the right to be different from the left.
    const wrote = voice.renderBlock(voice.createState(), SR, outL, input, { outputR: outR });

    // Reporting false is the whole contract. A renderer that gets it copies
    // channel 0 across, which is what makes skipping the pass correct rather
    // than merely cheaper.
    expect(wrote).toBe(false);
    expect(outR.every((v) => v === 0)).toBe(true);
  });

  it('mirroring gives the same block the second pass would have', () => {
    const graph = ASL.node(() => filter.lowpass(audio.input(), { cutoff: uniform(900), q: uniform(2) }));
    const input = tone(512, 180);

    const mirroredL = new Float32Array(512);
    const mirroredR = new Float32Array(512);
    const wrote = compileVoice(graph).renderBlock(
      compileVoice(graph).createState(),
      SR,
      mirroredL,
      input,
      { outputR: mirroredR },
    );
    expect(wrote).toBe(false);

    // The same graph handed an explicit right channel identical to the left,
    // which forces both passes to run for real.
    const bothL = new Float32Array(512);
    const bothR = new Float32Array(512);
    const voice = compileVoice(graph);
    expect(
      voice.renderBlock(voice.createState(), SR, bothL, input, {
        inputR: input.slice(),
        outputR: bothR,
      }),
    ).toBe(true);

    expect(Array.from(bothL)).toEqual(Array.from(mirroredL));
    // What the renderer would have copied is what the second pass produced.
    expect(Array.from(bothR)).toEqual(Array.from(mirroredL));
  });

  it('still runs both passes when the input really is stereo', () => {
    const graph = ASL.node(() => filter.lowpass(audio.input(), { cutoff: uniform(900) }));
    const voice = compileVoice(graph);
    const left = tone(256, 220);
    const right = tone(256, 660);
    const outL = new Float32Array(256);
    const outR = new Float32Array(256);

    expect(voice.renderBlock(voice.createState(), SR, outL, left, { inputR: right, outputR: outR })).toBe(
      true,
    );
    expect(Array.from(outL)).not.toEqual(Array.from(outR));
  });

  it('still runs both passes for a graph that asks which channel it is on', () => {
    // Auto-pan: the two sides are supposed to differ even from one source.
    const graph = ASL.node(() => audio.input().mul(audio.lane()));
    const voice = compileVoice(graph);
    const input = tone(64, 300);
    const outL = new Float32Array(64);
    const outR = new Float32Array(64);

    expect(voice.renderBlock(voice.createState(), SR, outL, input, { outputR: outR })).toBe(true);
    expect(outL.every((v) => v === 0)).toBe(true);
    expect(outR.some((v) => v !== 0)).toBe(true);
  });

  it('still runs both passes for a graph with noise in it', () => {
    // Two channels of the same noise generator are one mono channel, which
    // is audibly not what a stereo noise bed is for.
    const graph = ASL.node(() => audio.input().add(noise().mul(0.2)));
    const voice = compileVoice(graph);
    const input = new Float32Array(512);
    const outL = new Float32Array(512);
    const outR = new Float32Array(512);

    expect(voice.renderBlock(voice.createState(), SR, outL, input, { outputR: outR })).toBe(true);
    expect(Array.from(outL)).not.toEqual(Array.from(outR));
  });
});

describe('coefficient reuse', () => {
  it('a filter still follows its cutoff when the cutoff moves', () => {
    // The cache is keyed on the cutoff, so this is the test that fails if the
    // key is ever dropped: same graph, two settings, different sound.
    const build = (cutoff: number) =>
      ASL.node(() => filter.lowpass(audio.input(), { cutoff: uniform(cutoff) }));
    const input = tone(1024, 4000);

    const dark = new Float32Array(1024);
    const bright = new Float32Array(1024);
    const darkVoice = compileVoice(build(300));
    const brightVoice = compileVoice(build(12000));
    darkVoice.renderBlock(darkVoice.createState(), SR, dark, input, {});
    brightVoice.renderBlock(brightVoice.createState(), SR, bright, input, {});

    const energy = (b: Float32Array) => b.reduce((sum, v) => sum + v * v, 0);
    expect(energy(dark)).toBeLessThan(energy(bright) * 0.2);
  });

  it('a cutoff that changes mid-render is picked up on that sample', () => {
    const graph = ASL.node(({ cutoff }) => filter.lowpass(audio.input(), { cutoff }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    const input = tone(512, 5000);

    state.params.cutoff = 300;
    const dark = new Float32Array(512);
    voice.renderBlock(state, SR, dark, input, {});

    // Same voice, same state, same delay line: only the parameter moved.
    state.params.cutoff = 15000;
    const bright = new Float32Array(512);
    voice.renderBlock(state, SR, bright, input, {});

    const energy = (b: Float32Array) => b.reduce((sum, v) => sum + v * v, 0);
    expect(energy(bright)).toBeGreaterThan(energy(dark) * 4);
  });

  it('a shelf leaving bypass recomputes rather than reusing what it had', () => {
    // A 0 dB shelf takes an exact-bypass shortcut that never touches the
    // coefficients. Coming back out of it must not run on whatever was
    // cached before, which for a fresh voice is nothing at all.
    const graph = ASL.node(({ gainDb }) =>
      filter.lowshelf(audio.input(), { freq: uniform(200), gainDb }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    const input = tone(512, 100);

    state.params.gainDb = 0;
    const flat = new Float32Array(512);
    voice.renderBlock(state, SR, flat, input, {});
    expect(Array.from(flat)).toEqual(Array.from(input));

    state.params.gainDb = 12;
    const boosted = new Float32Array(512);
    voice.renderBlock(state, SR, boosted, input, {});
    const energy = (b: Float32Array) => b.reduce((sum, v) => sum + v * v, 0);
    expect(energy(boosted)).toBeGreaterThan(energy(flat) * 2);
    expect(boosted.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('a compressor still responds to attack and release settings', () => {
    const build = (attack: number) =>
      ASL.node(() =>
        compressor(audio.input(), {
          threshold: uniform(0.1),
          ratio: uniform(8),
          attack: uniform(attack),
          release: uniform(0.2),
        }),
      );
    const input = new Float32Array(2048).fill(0.8);

    const fast = new Float32Array(2048);
    const slow = new Float32Array(2048);
    const fastVoice = compileVoice(build(0.0005));
    const slowVoice = compileVoice(build(0.2));
    fastVoice.renderBlock(fastVoice.createState(), SR, fast, input, {});
    slowVoice.renderBlock(slowVoice.createState(), SR, slow, input, {});

    // A fast attack has clamped down by the end of the block; a slow one is
    // still on its way there. Same cached-coefficient path, different times.
    expect(fast[2047]!).toBeLessThan(slow[2047]!);
  });
});
