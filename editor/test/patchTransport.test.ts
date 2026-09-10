import { describe, expect, it } from 'vitest';
import {
  TIME_SIG_PRESETS,
  applyTransportToMaterial,
  isTransportKind,
  resolvedTransport,
  transportFromMaterial,
  transportMaterial,
} from '../../src/index';
import { nodeInputs, nodeOutputs } from '../src/controlInputs';

describe('transport material in the editor', () => {
  it('exposes session params as CV inlets and named outlets', () => {
    const material = transportMaterial.duplicate();
    expect(isTransportKind(material.kind)).toBe(true);
    expect(nodeInputs(material)).toEqual(['bpm', 'beatsPerBar', 'beatUnit']);
    expect(nodeOutputs(material)).toEqual([
      'bpm',
      'beats',
      'bars',
      'playing',
      'beatsPerBar',
      'beatUnit',
      'pulse',
    ]);
  });

  it('round-trips a 6/8 preset onto the material', () => {
    const material = transportMaterial.duplicate();
    const sixEight = TIME_SIG_PRESETS.find((preset) => preset.label === '6/8');
    expect(sixEight).toBeDefined();
    applyTransportToMaterial(material, { bpm: 90, ...sixEight });
    expect(transportFromMaterial(material)).toEqual({
      bpm: 90,
      beatsPerBar: 6,
      beatUnit: 8,
    });
  });

  it('fills missing tempo fields with 120 and 4/4', () => {
    expect(resolvedTransport(null)).toEqual({ bpm: 120, beatsPerBar: 4, beatUnit: 4 });
    expect(resolvedTransport({ bpm: 0, beatsPerBar: -1 })).toEqual({
      bpm: 120,
      beatsPerBar: 4,
      beatUnit: 4,
    });
  });
});
