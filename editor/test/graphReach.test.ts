import { describe, expect, it } from 'vitest';
import { idsFeedingAnalysis, idsReachingMaster, liveNodeIds } from '../src/graphReach';

describe('idsReachingMaster', () => {
  it('keeps the mix path and drops a click sidecar that never hits Master', () => {
    const seen = idsReachingMaster(
      [
        { id: 'keys', kind: 'keyboard' },
        { id: 'synth', kind: 'synth' },
        { id: 'clock', kind: 'clock' },
        { id: 'pulse', kind: 'pulse' },
        { id: 'gainClk', kind: 'gain' },
        { id: 'master', kind: 'master' },
      ],
      [
        { source: 'keys', target: 'synth' },
        { source: 'synth', target: 'master' },
        { source: 'clock', target: 'pulse' },
        { source: 'pulse', target: 'gainClk' },
      ],
    );
    expect([...seen].sort()).toEqual(['keys', 'master', 'synth']);
  });

  it('keeps a CV source that only reaches Master through a param cable', () => {
    const seen = idsReachingMaster(
      [
        { id: 'lfo', kind: 'lfo' },
        { id: 'osc', kind: 'oscillator' },
        { id: 'master', kind: 'master' },
      ],
      [
        { source: 'lfo', target: 'osc' },
        { source: 'osc', target: 'master' },
      ],
    );
    expect(seen.has('lfo')).toBe(true);
    expect(seen.has('osc')).toBe(true);
  });
});

describe('liveNodeIds', () => {
  it('keeps a fed tuner even when it never reaches Master', () => {
    const nodes = [
      { id: 'line', kind: 'line' },
      { id: 'tuner', kind: 'tuner' },
      { id: 'osc', kind: 'oscillator' },
      { id: 'master', kind: 'master' },
    ];
    const connections = [
      { source: 'line', target: 'tuner' },
      { source: 'osc', target: 'master' },
    ];
    expect([...idsFeedingAnalysis(nodes, connections)].sort()).toEqual(['line', 'tuner']);
    const live = liveNodeIds(nodes, connections);
    expect(live.has('tuner')).toBe(true);
    expect(live.has('line')).toBe(true);
    expect(live.has('osc')).toBe(true);
    expect(live.has('master')).toBe(true);
  });

  it('keeps a clock that only feeds MIDI Out', () => {
    const nodes = [
      { id: 'clock', kind: 'clock' },
      { id: 'midi', kind: 'midiout' },
      { id: 'osc', kind: 'oscillator' },
      { id: 'master', kind: 'master' },
    ];
    const connections = [
      { source: 'clock', target: 'midi' },
      { source: 'osc', target: 'master' },
    ];
    const live = liveNodeIds(nodes, connections);
    expect(live.has('clock')).toBe(true);
    expect(live.has('midi')).toBe(true);
    expect(live.has('osc')).toBe(true);
  });
});
