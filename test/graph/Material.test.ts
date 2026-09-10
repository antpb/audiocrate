import { describe, expect, it } from 'vitest';
import { Material } from '../../src/graph/Material';
import { param } from '../../src/graph/param';
import { compileVoice } from '../../src/asl/compile';
import { uniform } from '../../src/asl/builders';

const SR = 48000;

describe('param.range', () => {
  it('rejects an inverted range', () => {
    expect(() => param.range(10, 5, { default: 7 })).toThrow(RangeError);
  });

  it('rejects a default outside the range', () => {
    expect(() => param.range(0, 10, { default: 20 })).toThrow(RangeError);
    expect(() => param.range(0, 10, { default: -1 })).toThrow(RangeError);
  });

  it('accepts a valid range and carries the unit through', () => {
    const p = param.range(-18, 18, { default: 0, unit: 'dB' });
    expect(p).toEqual({ kind: 'range', min: -18, max: 18, default: 0, unit: 'dB' });
  });

  it('carries an optional AU/VST3 address and omits it when unset', () => {
    const withAddr = param.range(0, 4, { default: 1, unit: 'lin', address: 0 });
    expect(withAddr.address).toBe(0);
    const bare = param.range(0, 1, { default: 0 });
    expect(bare.address).toBeUndefined();
    expect('address' in bare).toBe(false);
  });
});

describe('Material param schema', () => {
  it('rejects an automatable entry that references an undeclared param', () => {
    expect(
      () =>
        new Material({
          name: 'Bad',
          params: { gain: param.range(0, 1, { default: 0.5 }) },
          automatable: ['gain', 'nope'],
          graph: () => uniform(0),
        }),
    ).toThrow(RangeError);
  });

  it('seeds param values from each descriptor default', () => {
    const material = new Material({
      name: 'Gain',
      params: { gain: param.range(0, 2, { default: 1 }) },
      graph: ({ params }) => params.gain,
    });
    expect(material.getParam('gain')).toBe(1);
  });

  it('setParam validates against the param range', () => {
    const material = new Material({
      name: 'Gain',
      params: { gain: param.range(0, 2, { default: 1 }) },
      graph: ({ params }) => params.gain,
    });
    material.setParam('gain', 1.5);
    expect(material.getParam('gain')).toBe(1.5);
    expect(() => material.setParam('gain', 3)).toThrow(RangeError);
    expect(() => material.setParam('nope', 1)).toThrow(RangeError);
  });

  it('getParam/setParam reject an undeclared param name', () => {
    const material = new Material({ name: 'Empty', graph: () => uniform(0) });
    expect(() => material.getParam('missing')).toThrow(RangeError);
  });

  it('snapshotParams returns a plain, independent copy', () => {
    const material = new Material({
      name: 'Gain',
      params: { gain: param.range(0, 2, { default: 1 }) },
      graph: ({ params }) => params.gain,
    });
    const snapshot = material.snapshotParams();
    expect(snapshot).toEqual({ gain: 1 });
    material.setParam('gain', 2);
    expect(snapshot).toEqual({ gain: 1 }); // unaffected by the later mutation
  });

  it('rejects a graph builder that does not return an ASLValue', () => {
    expect(() => new Material({ name: 'Bad', graph: () => 5 as never })).toThrow(TypeError);
  });
});

describe('Material graph wiring', () => {
  it('every declared param resolves to a real, independently-addressable node', () => {
    const material = new Material({
      name: 'Sum',
      params: {
        a: param.range(0, 10, { default: 2 }),
        b: param.range(0, 10, { default: 3 }),
      },
      graph: ({ params }) => params.a.add(params.b),
    });

    const voice = compileVoice(material.graph);
    const state = voice.createState();
    voice.noteOn(state, material.snapshotParams());
    expect(voice.renderSample(state, SR)).toBe(5);
  });

  it('a graph that never reads a declared param still compiles (param exists, just unused)', () => {
    const material = new Material({
      name: 'Ignoring',
      params: { unused: param.range(0, 1, { default: 0.5 }) },
      graph: () => uniform(42),
    });
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    voice.noteOn(state, material.snapshotParams());
    expect(voice.renderSample(state, SR)).toBe(42);
  });

  it('duplicate() is a separate instance that keeps param values', () => {
    const material = new Material({
      name: 'Gain',
      kind: 'gain',
      params: { gain: param.range(0, 4, { default: 1 }) },
      graph: ({ input, params }) => input.mul(params.gain),
    });
    material.setParam('gain', 0.25);
    const copy = material.duplicate();
    expect(copy).not.toBe(material);
    expect(copy.kind).toBe('gain');
    expect(copy.getParam('gain')).toBe(0.25);
    copy.setParam('gain', 2);
    expect(material.getParam('gain')).toBe(0.25);
  });
});
