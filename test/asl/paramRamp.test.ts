/**
 * Continuous parameters glide when a host moves them; everything else jumps.
 *
 * The rule (`isSmoothedParam`) is decided by what a parameter is, and the
 * glide is short (`PARAM_RAMP_SECONDS`) so a large deliberate change is not
 * made to feel late. Both halves are pinned here: which parameters glide, and
 * that a glide ends where and when it says.
 */
import { describe, expect, it } from 'vitest';
import { ASL } from '../../src/asl/graph';
import { compileVoice, PARAM_RAMP_SECONDS, paramRampFrames } from '../../src/asl/compile';
import { uniform } from '../../src/asl/builders';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { isSmoothedParam, param } from '../../src/graph/param';
import { BlockRenderer } from '../../src/renderers/BlockRenderer';

const SR = 48000;
const RAMP = paramRampFrames(SR);

function material() {
  return new AudioMaterial({
    name: 'Probe',
    kind: 'probe',
    params: {
      level: param.range(0, 1, { default: 0 }),
      jumpy: param.range(0, 1, { default: 0, smooth: false }),
      octave: param.stepped(-2, 2, { default: 0, step: 1 }),
      mode: param.enum(['a', 'b', 'c'], { default: 'a' }),
      on: param.toggle({ default: false }),
    },
    // Sum everything so one output shows whichever parameter moved.
    graph: ({ params }) =>
      params.level!.add(params.jumpy!).add(params.octave!).add(params.mode!).add(params.on!),
  });
}

/** Renders `frames` samples as one block and returns them. */
function block(voice: ReturnType<typeof compileVoice>, state: ReturnType<ReturnType<typeof compileVoice>['createState']>, frames: number) {
  const out = new Float32Array(frames);
  voice.renderBlock(state, SR, out);
  return Array.from(out);
}

describe('which parameters glide', () => {
  it('continuous ranges do; stepped, enum, toggle and smooth: false do not', () => {
    const m = material();
    expect(m.graph.smooth).toEqual(['level']);
    expect(isSmoothedParam(m.params.level!)).toBe(true);
    for (const name of ['jumpy', 'octave', 'mode', 'on']) expect(isSmoothedParam(m.params[name]!), name).toBe(false);
  });

  it('a graph built with ASL.node has no smooth list, so nothing about it changed', () => {
    expect(ASL.node(({ x }) => x!).smooth).toBeUndefined();
  });
});

describe('a glide', () => {
  const setup = () => {
    const m = material();
    const voice = compileVoice(m.graph);
    const state = voice.createState();
    voice.noteOn(state, m.snapshotParams());
    block(voice, state, 128);
    return { voice, state };
  };

  it('is 5 ms: short enough that a large change still lands at once', () => {
    expect(PARAM_RAMP_SECONDS).toBe(0.005);
    expect(RAMP).toBe(240);
  });

  it('moves a continuous parameter in a straight line and lands on the target exactly', () => {
    const { voice, state } = setup();
    voice.setParam(state, 'level', 0.6);
    const out = [...block(voice, state, 128), ...block(voice, state, 128), ...block(voice, state, 128)];
    expect(out[0]).toBe(0);
    for (let i = 1; i < RAMP; i++) expect(out[i]!).toBeCloseTo((0.6 * i) / RAMP, 6);
    // Exactly the target, not base + step * frames, from the frame it arrives.
    for (let i = RAMP; i < out.length; i++) expect(out[i]).toBe(Math.fround(0.6));
    expect(state.params.level).toBe(0.6);
  });

  it('never makes a discrete parameter pass through values nobody chose', () => {
    const { voice, state } = setup();
    voice.setParam(state, 'octave', 2);
    voice.setParam(state, 'mode', 2);
    voice.setParam(state, 'on', 1);
    voice.setParam(state, 'jumpy', 0.5);
    expect(block(voice, state, 4)).toEqual([5.5, 5.5, 5.5, 5.5]);
  });

  it('retargeted mid-glide, carries on from where it is rather than jumping', () => {
    const { voice, state } = setup();
    voice.setParam(state, 'level', 1);
    const first = block(voice, state, 60);
    voice.setParam(state, 'level', 0);
    const second = block(voice, state, 4);
    const where = 60 / RAMP;
    expect(first.at(-1)!).toBeCloseTo(59 / RAMP, 6);
    expect(second[0]!).toBeCloseTo(where, 6);
    expect(second[1]!).toBeLessThan(second[0]!);
  });

  it('does not glide anything set before the voice first renders, or anything a note carries', () => {
    const m = material();
    const voice = compileVoice(m.graph);
    const state = voice.createState();
    voice.setParam(state, 'level', 0.25);
    expect(block(voice, state, 2)).toEqual([0.25, 0.25]);
    voice.noteOn(state, { level: 0.75 });
    expect(block(voice, state, 2)).toEqual([0.75, 0.75]);
  });

  it('follows through a block-constant subtree, which would otherwise hold one value per block', () => {
    // `level * 2 + 1` is parameters and constants only, so it is computed
    // once per block. A glide has to reach it per sample.
    const graph = { ...ASL.node(({ level }) => level!.mul(2).add(uniform(1))), smooth: ['level'] };
    const voice = compileVoice(graph);
    expect(voice.blockConstantNodes).toBeGreaterThan(0);
    const state = voice.createState();
    voice.noteOn(state, { level: 0 });
    block(voice, state, 8);
    voice.setParam(state, 'level', 1);
    const out = block(voice, state, 8);
    expect(new Set(out).size).toBe(8);
    expect(out[4]!).toBeCloseTo(1 + (2 * 4) / RAMP, 6);
  });

  it('is what BlockRenderer.setParam does', () => {
    const m = material();
    const renderer = new BlockRenderer(m.graph, { params: m.snapshotParams() });
    renderer.render(128);
    renderer.setParam('level', 1);
    const out = renderer.render(8).left;
    expect(out[0]).toBe(0);
    expect(out[4]!).toBeCloseTo(4 / RAMP, 6);
  });
});
