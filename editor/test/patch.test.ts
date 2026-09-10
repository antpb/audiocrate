import { describe, expect, it } from 'vitest';
import { isCratePatch, parsePatch, performancePatch, starterPatch, stringifyPatch } from '../src/patch';

describe('crate.patch', () => {
  it('round-trips the starter graph', () => {
    const raw = stringifyPatch(starterPatch());
    const parsed = parsePatch(raw);
    expect(parsed.kind).toBe('crate.patch');
    expect(parsed.nodes.map((node) => node.kind)).toEqual([
      'transport',
      'keyboard',
      'oscillator',
      'adsr',
      'lfo',
      'lowpass',
      'delay',
      'master',
    ]);
    expect(parsed.transport).toEqual({ bpm: 120, beatsPerBar: 4, beatUnit: 4 });
    expect(parsed.connections).toHaveLength(9);
    expect(parsed.connections.some((conn) => conn.source === 'adsr' && conn.targetInput === 'cutoff')).toBe(true);
    expect(parsed.connections.some((conn) => conn.source === 'lfo' && conn.targetInput === 'width')).toBe(true);
    expect(isCratePatch(parsed)).toBe(true);
  });

  it('maps the recorder lanes: instrument, armed guitar, click, master bus', () => {
    const parsed = parsePatch(stringifyPatch(performancePatch()));
    const kinds = parsed.nodes.map((node) => node.kind);
    expect(kinds).toContain('keyboard');
    expect(kinds).toContain('synth');
    expect(kinds).toContain('line');
    expect(kinds).toContain('amp');
    expect(kinds).toContain('ir');
    expect(kinds).toContain('transport');
    expect(kinds).toContain('clock');
    expect(kinds).toContain('limiter');
    expect(kinds).toContain('master');
    expect(parsed.connections.some((conn) => conn.source === 'line' && conn.target === 'amp')).toBe(true);
    expect(parsed.connections.some((conn) => conn.source === 'keys' && conn.target === 'synth')).toBe(true);
    expect(parsed.connections.filter((conn) => conn.target === 'limiter')).toHaveLength(2);
    expect(
      parsed.connections.some(
        (conn) =>
          (conn.source === 'clock' || conn.source === 'pulse' || conn.source === 'gainClk') &&
          (conn.target === 'limiter' || conn.target === 'master'),
      ),
    ).toBe(false);
    expect(isCratePatch(parsed)).toBe(true);
  });

  it('rejects a DAW project-shaped object', () => {
    expect(isCratePatch({ version: 1, tracks: [] })).toBe(false);
    expect(() => parsePatch('{"hello":true}')).toThrow(/crate.patch/);
  });
});
