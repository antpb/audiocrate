import { describe, expect, it } from 'vitest';
import {
  denormalizeParam,
  enumValue,
  formatParam,
  normalizeParam,
  param,
  paramNameForAddress,
  quantizeParam,
} from '../../src/graph/param';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { uniform } from '../../src/asl/builders';

describe('param.range', () => {
  it('validates bounds and default at declaration', () => {
    expect(() => param.range(10, 1, { default: 5 })).toThrow(RangeError);
    expect(() => param.range(0, 1, { default: 2 })).toThrow(RangeError);
  });

  it('has no step, so nothing snaps', () => {
    const desc = param.range(0, 1, { default: 0.5 });
    expect(desc.step).toBeUndefined();
    expect(quantizeParam(desc, 0.3737)).toBe(0.3737);
  });
});

describe('param.stepped', () => {
  it('rejects a step that does not divide the span', () => {
    // The top of the control would be unreachable, which looks like a bug.
    expect(() => param.stepped(0, 10, { step: 3, default: 0 })).toThrow(RangeError);
  });

  it('rejects a default off the grid', () => {
    expect(() => param.stepped(0, 10, { step: 2, default: 3 })).toThrow(RangeError);
  });

  it('rejects a non-positive step', () => {
    expect(() => param.stepped(0, 10, { step: 0, default: 0 })).toThrow(RangeError);
  });

  it('snaps to the nearest legal value and clamps at the edges', () => {
    const desc = param.stepped(1, 16, { step: 1, default: 8 });
    expect(quantizeParam(desc, 8.4)).toBe(8);
    expect(quantizeParam(desc, 8.6)).toBe(9);
    expect(quantizeParam(desc, 99)).toBe(16);
    expect(quantizeParam(desc, -99)).toBe(1);
  });

  it('lands exactly on the grid rather than accumulating float error', () => {
    const desc = param.stepped(0, 1, { step: 0.1, default: 0 });
    expect(quantizeParam(desc, 0.7000000001)).toBe(0.7);
    expect(quantizeParam(desc, 0.29)).toBe(0.3);
  });

  it('works on a grid that does not start at zero', () => {
    const desc = param.stepped(-12, 12, { step: 3, default: 0 });
    expect(quantizeParam(desc, 1)).toBe(0);
    expect(quantizeParam(desc, 2)).toBe(3);
    expect(quantizeParam(desc, -10)).toBe(-9);
  });
});

describe('param.enum', () => {
  const shape = param.enum(['sine', 'saw', 'square'], { default: 'saw' });

  it('stores the default as an index', () => {
    expect(shape.default).toBe(1);
    expect(shape.min).toBe(0);
    expect(shape.max).toBe(2);
  });

  it('rejects a default that is not an option', () => {
    // @ts-expect-error the literal type already rejects this; the check is for JS callers
    expect(() => param.enum(['a', 'b'], { default: 'c' })).toThrow(RangeError);
  });

  it('rejects duplicates and single-option lists', () => {
    expect(() => param.enum(['a', 'a'], { default: 'a' })).toThrow(RangeError);
    expect(() => param.enum(['a'], { default: 'a' })).toThrow(RangeError);
  });

  it('formats as the option name', () => {
    expect(formatParam(shape, 0)).toBe('sine');
    expect(formatParam(shape, 2)).toBe('square');
  });

  it('formats an interpolated value as the option it snaps to', () => {
    // An automation lane between two options has to read as one of them.
    expect(formatParam(shape, 1.4)).toBe('saw');
    expect(formatParam(shape, 1.6)).toBe('square');
  });

  it('resolves an option name to its value, and throws on a typo', () => {
    expect(enumValue(shape, 'square')).toBe(2);
    // @ts-expect-error deliberately not an option
    expect(() => enumValue(shape, 'sqaure')).toThrow(RangeError);
  });
});

describe('param.toggle', () => {
  it('is a 0..1 param with labels', () => {
    const desc = param.toggle({ default: true });
    expect(desc.default).toBe(1);
    expect(desc.min).toBe(0);
    expect(desc.max).toBe(1);
    expect(formatParam(desc, 0)).toBe('Off');
    expect(formatParam(desc, 1)).toBe('On');
  });

  it('takes custom labels', () => {
    const desc = param.toggle({ default: false, labels: ['Play', 'Record'] });
    expect(formatParam(desc, 0)).toBe('Play');
    expect(formatParam(desc, 1)).toBe('Record');
  });

  it('reads a midpoint as on, matching how it snaps', () => {
    const desc = param.toggle({ default: false });
    expect(quantizeParam(desc, 0.5)).toBe(1);
    expect(formatParam(desc, 0.5)).toBe('On');
    expect(formatParam(desc, 0.49)).toBe('Off');
  });
});

describe('normalize / denormalize', () => {
  it('round-trips a range', () => {
    const desc = param.range(20, 20000, { default: 1000, unit: 'Hz' });
    expect(normalizeParam(desc, 20)).toBe(0);
    expect(normalizeParam(desc, 20000)).toBe(1);
    expect(denormalizeParam(desc, normalizeParam(desc, 5000))).toBeCloseTo(5000, 6);
  });

  it('clamps rather than extrapolating', () => {
    const desc = param.range(0, 1, { default: 0 });
    expect(normalizeParam(desc, 5)).toBe(1);
    expect(denormalizeParam(desc, -3)).toBe(0);
  });

  it('lands on a legal value when the descriptor has a grid', () => {
    const desc = param.stepped(1, 5, { step: 1, default: 1 });
    expect(denormalizeParam(desc, 0.3)).toBe(2);
    expect(denormalizeParam(desc, 0.6)).toBe(3);
  });
});

describe('formatParam', () => {
  it('appends a unit and picks a sensible precision from the span', () => {
    expect(formatParam(param.range(20, 20000, { default: 1000, unit: 'Hz' }), 440)).toBe('440 Hz');
    expect(formatParam(param.range(-18, 18, { default: 0, unit: 'dB' }), -3.25)).toBe('-3.3 dB');
    expect(formatParam(param.range(0, 1, { default: 0 }), 0.25)).toBe('0.25');
  });

  it('drops trailing zeros but keeps a whole number whole', () => {
    expect(formatParam(param.range(0, 1, { default: 0 }), 0.5)).toBe('0.5');
    expect(formatParam(param.range(0, 1000, { default: 0 }), 12)).toBe('12');
  });
});

describe('paramNameForAddress', () => {
  it('finds a param by its plugin address across every kind', () => {
    const params = {
      drive: param.range(0, 1, { default: 0, address: 3 }),
      shape: param.enum(['a', 'b'], { default: 'a', address: 7 }),
      on: param.toggle({ default: false, address: 9 }),
    };
    expect(paramNameForAddress(params, 3)).toBe('drive');
    expect(paramNameForAddress(params, 7)).toBe('shape');
    expect(paramNameForAddress(params, 9)).toBe('on');
    expect(paramNameForAddress(params, 4)).toBeNull();
  });
});

describe('AudioMaterial with non-range params', () => {
  const material = new AudioMaterial({
    name: 'Shaper',
    params: {
      shape: param.enum(['sine', 'saw', 'square'], { default: 'saw' }),
      poles: param.stepped(2, 8, { step: 2, default: 4 }),
      active: param.toggle({ default: true }),
      drive: param.range(0, 1, { default: 0.5 }),
    },
    automatable: ['shape', 'drive'],
    graph: ({ params }) => uniform(1).mul(params.drive),
  });

  it('starts at each descriptor default', () => {
    expect(material.getParam('shape')).toBe(1);
    expect(material.getParam('poles')).toBe(4);
    expect(material.getParam('active')).toBe(1);
  });

  it('snaps a write onto the grid instead of throwing', () => {
    material.setParam('poles', 5.4);
    expect(material.getParam('poles')).toBe(6);
    material.setParam('shape', 0.4);
    expect(material.getParam('shape')).toBe(0);
  });

  it('still throws outside the declared bounds', () => {
    // Off the grid is a legitimate interpolated value. Out of range is a bug.
    expect(() => material.setParam('poles', 99)).toThrow(RangeError);
    expect(() => material.setParam('shape', -1)).toThrow(RangeError);
  });

  it('leaves a continuous param exactly as written', () => {
    material.setParam('drive', 0.3737);
    expect(material.getParam('drive')).toBe(0.3737);
  });

  it('sets and reads an enum by option name', () => {
    material.setOption('shape', 'square');
    expect(material.getOption('shape')).toBe('square');
    expect(material.getParam('shape')).toBe(2);
    expect(material.formatParam('shape')).toBe('square');
  });

  it('refuses option access on a param that is not an enum', () => {
    expect(() => material.setOption('drive', 'loud')).toThrow(TypeError);
    expect(() => material.getOption('poles')).toThrow(TypeError);
  });

  it('reports unknown params by name', () => {
    expect(() => material.setOption('nope', 'x')).toThrow(RangeError);
    expect(() => material.formatParam('nope')).toThrow(RangeError);
  });
});

describe('parameter curves', () => {
  const hz = param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' });

  it('gives a log-tapered frequency control usable travel at the bottom', () => {
    // Linear, 200 Hz sits at one percent of the fader. Log puts it near a
    // third, which is the difference between a usable control and a trap.
    const linear = param.range(20, 20000, { default: 1000, unit: 'Hz' });
    expect(normalizeParam(linear, 200)).toBeCloseTo(0.009, 3);
    expect(normalizeParam(hz, 200)).toBeCloseTo(0.333, 2);
  });

  it('puts each octave the same distance apart under a log taper', () => {
    const octave = normalizeParam(hz, 400) - normalizeParam(hz, 200);
    expect(normalizeParam(hz, 800) - normalizeParam(hz, 400)).toBeCloseTo(octave, 9);
    expect(normalizeParam(hz, 1600) - normalizeParam(hz, 800)).toBeCloseTo(octave, 9);
  });

  it('round-trips through the taper', () => {
    for (const value of [20, 100, 440, 5000, 20000]) {
      expect(denormalizeParam(hz, normalizeParam(hz, value))).toBeCloseTo(value, 6);
    }
  });

  it('still pins the ends to 0 and 1', () => {
    expect(normalizeParam(hz, 20)).toBeCloseTo(0, 12);
    expect(normalizeParam(hz, 20000)).toBeCloseTo(1, 12);
    expect(denormalizeParam(hz, 0)).toBeCloseTo(20, 9);
    expect(denormalizeParam(hz, 1)).toBeCloseTo(20000, 9);
  });

  it('uses exp where the range reaches zero, which log cannot', () => {
    const time = param.range(0, 2, { default: 0.1, unit: 's', curve: 'exp' });
    expect(normalizeParam(time, 0)).toBe(0);
    expect(normalizeParam(time, 2)).toBe(1);
    // A tenth of a second sits at a fifth of the travel rather than a
    // twentieth.
    expect(normalizeParam(time, 0.1)).toBeCloseTo(0.224, 3);
    expect(denormalizeParam(time, normalizeParam(time, 0.4))).toBeCloseTo(0.4, 9);
  });

  it('refuses a log curve on a range that includes zero', () => {
    expect(() => param.range(0, 1, { default: 0.5, curve: 'log' })).toThrow(RangeError);
    expect(() => param.range(-1, 1, { default: 0, curve: 'log' })).toThrow(RangeError);
  });

  it('does not store an explicit linear curve, because that is the default', () => {
    expect(param.range(0, 1, { default: 0, curve: 'linear' }).curve).toBeUndefined();
  });

  it('leaves the stored value and the display in real units', () => {
    // The taper is a control-surface mapping. Nothing downstream sees it.
    expect(formatParam(hz, 440)).toBe('440 Hz');
    expect(quantizeParam(hz, 440)).toBe(440);
  });

  it('lands on the grid when a stepped param is also tapered', () => {
    const stepped = param.stepped(1, 64, { step: 1, default: 4, curve: 'exp' });
    expect(denormalizeParam(stepped, 0.5)).toBe(17);
    expect(Number.isInteger(denormalizeParam(stepped, 0.37))).toBe(true);
  });
});
