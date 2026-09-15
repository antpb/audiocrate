import { describe, expect, it } from 'vitest';
import { parseNodeClip, pasteOffset, stringifyNodeClip } from '../src/nodeClip';

describe('node clipboard', () => {
  it('round-trips kind, params, and data without the source id', () => {
    const raw = stringifyNodeClip({
      id: 'osc',
      kind: 'oscillator',
      x: 280,
      y: 36,
      params: { type: 1, gain: 0.35 },
      data: { monitor: 1 },
    });
    expect(raw).not.toContain('"id"');
    const parsed = parseNodeClip(raw);
    expect(parsed).toEqual({
      id: '',
      kind: 'oscillator',
      x: 280,
      y: 36,
      params: { type: 1, gain: 0.35 },
      data: { monitor: 1 },
    });
  });

  it('rejects ordinary patch JSON', () => {
    expect(parseNodeClip('{"version":1,"kind":"crate.patch","nodes":[],"connections":[]}')).toBeNull();
    expect(parseNodeClip('not json')).toBeNull();
  });

  it('nudges each paste down and right', () => {
    expect(pasteOffset(280, 36, 1)).toEqual({ x: 316, y: 72 });
    expect(pasteOffset(280, 36, 2)).toEqual({ x: 352, y: 108 });
  });
});
