import { describe, expect, it } from 'vitest';
import { lowpassMaterial } from '../../src/materials/filters';
import { oscillatorMaterial, toneMaterial } from '../../src/materials/sources';
import { reverbMaterial } from '../../src/materials/reverb';
import { adsrMaterial, euclideanMaterial, lfoMaterial, sequencerMaterial } from '../../src/materials/control';
import { tunerMaterial } from '../../src/materials/meters';
import { looperMaterial } from '../../src/materials/time';
import { nodeInputs, nodeOutputs, tapOutputNames } from '../src/controlInputs';

describe('nodeInputs', () => {
  it('exposes audio, note jacks, and automatable CV on a source', () => {
    expect(nodeInputs(oscillatorMaterial)).toEqual([
      'note',
      'gate',
      'velocity',
      'gain',
      'width',
      'octave',
      'detune',
    ]);
  });

  it('gives tone a freq jack and no note jack', () => {
    expect(nodeInputs(toneMaterial)).toEqual(['freq', 'gain']);
    expect(nodeOutputs(toneMaterial)).toEqual(['audio']);
  });

  it('gives reverb an audio inlet plus room params', () => {
    expect(nodeInputs(reverbMaterial)).toEqual(['input', 'size', 'decay', 'damp', 'mix']);
  });

  it('exposes the audio inlet plus cutoff/q on a filter', () => {
    expect(nodeInputs(lowpassMaterial)).toEqual(['input', 'cutoff', 'q']);
  });

  it('gives a sequencer a clock inlet and a cv outlet, not an audio path', () => {
    expect(sequencerMaterial.audioInputs).toEqual([]);
    expect(nodeInputs(sequencerMaterial)).toContain('clock');
    expect(nodeInputs(sequencerMaterial)).not.toContain('input');
    expect(nodeOutputs(sequencerMaterial)).toEqual(['cv']);
  });

  it('gives euclidean a clock inlet and a cv outlet', () => {
    expect(euclideanMaterial.audioInputs).toEqual([]);
    expect(nodeInputs(euclideanMaterial)).toContain('clock');
    expect(nodeInputs(euclideanMaterial)).not.toContain('input');
    expect(nodeOutputs(euclideanMaterial)).toEqual(['cv']);
  });

  it('gives envelopes and LFOs a cv outlet', () => {
    expect(nodeOutputs(adsrMaterial)).toEqual(['cv']);
    expect(nodeOutputs(lfoMaterial)).toEqual(['cv']);
    expect(nodeOutputs(oscillatorMaterial)).toEqual(['audio']);
    expect(nodeOutputs(lowpassMaterial)).toEqual(['audio']);
    expect(tapOutputNames(adsrMaterial)).toEqual(['cv', 'audio']);
    expect(tapOutputNames(lfoMaterial)).toEqual(['cv', 'audio']);
    expect(tapOutputNames(oscillatorMaterial)).toEqual(['audio']);
  });

  it('gives tuner named CV outlets for the pitch it reads', () => {
    expect(nodeOutputs(tunerMaterial)).toEqual(['audio', 'note', 'cv', 'hz', 'cents', 'gate']);
  });

  it('gives looper start and end pulses next to audio', () => {
    expect(nodeOutputs(looperMaterial)).toEqual(['audio', 'start', 'end']);
  });
});
