import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../../src/asl/compile';
import { ampMaterial, ampParams, AMP_EQ_FREQS } from './ampMaterial';

const SR = 48000;

describe('ampMaterial', () => {
  it('declares the 46-param AUv3 tree with stable addresses', () => {
    expect(Object.keys(ampParams)).toHaveLength(46);
    expect(ampMaterial.automatable).toHaveLength(46);
    expect(ampMaterial.params.inputGain?.address).toBe(0);
    expect(ampMaterial.params.eqBand0?.address).toBe(3);
    expect(ampMaterial.params.morphTargetIR?.address).toBe(46);
    expect(ampMaterial.params.inputCalibration).toBeUndefined();
    expect(AMP_EQ_FREQS).toEqual([80, 250, 800, 3200, 8000]);
  });

  it('is an exact analog bypass at defaults: NAM is passthrough, EQ at 0 dB, gains at 1', () => {
    const voice = compileVoice(ampMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, ampMaterial.snapshotParams());

    for (const sample of [0.3, -0.5, 0.9, 0, -1]) {
      state.params.input = sample;
      expect(voice.renderSample(state, SR)).toBeCloseTo(sample, 10);
    }
  });

  it('inputGain scales the dry signal and inputPad applies -20 dB (x0.1)', () => {
    const voice = compileVoice(ampMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { ...ampMaterial.snapshotParams(), inputGain: 2 });
    state.params.input = 0.4;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.8, 10);

    voice.noteOn(state, { ...ampMaterial.snapshotParams(), inputPad: 1, inputGain: 1 });
    state.params.input = 0.5;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.05, 10);
  });

  it('a mid EQ boost changes a tone at 800 Hz; unused reverb/delay params do not', () => {
    function rms(overrides: Record<string, number>): number {
      const voice = compileVoice(ampMaterial.graph);
      const state = voice.createState();
      voice.noteOn(state, { ...ampMaterial.snapshotParams(), ...overrides });
      const block = new Float32Array(2000);
      for (let i = 0; i < block.length; i++) {
        state.params.input = Math.sin((2 * Math.PI * 800 * i) / SR);
        block[i] = voice.renderSample(state, SR);
      }
      const settled = block.slice(500);
      return Math.sqrt(settled.reduce((sum, v) => sum + v * v, 0) / settled.length);
    }

    const flat = rms({});
    const boosted = rms({ eqBand2: 12 });
    const reverbTwiddled = rms({ reverbBlend: 1, delayMix: 1, morphEnable: 1 });
    expect(boosted).toBeGreaterThan(flat);
    expect(reverbTwiddled).toBeCloseTo(flat, 5);
  });
});
