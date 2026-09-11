import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../../src/asl/compile';
import { spaceReverbMaterial, spaceReverbParams } from './spaceReverbMaterial';
import { SPACE_REVERB_KERNEL_SLOT } from './kernelSlot';

const SR = 48000;

describe('spaceReverbMaterial', () => {
  it('declares the Costello tree the amp exposes, on this plugin\'s addresses', () => {
    expect(Object.keys(spaceReverbParams)).toEqual([
      'reverbDecay',
      'reverbBlend',
      'reverbSize',
      'reverbPreDelay',
      'reverbTone',
      'reverbGate',
    ]);
    expect(spaceReverbMaterial.automatable).toEqual(Object.keys(spaceReverbParams));
    expect(spaceReverbMaterial.kind).toBe('spacereverb');
    expect(spaceReverbMaterial.params.reverbDecay?.address).toBe(0);
    expect(spaceReverbMaterial.params.reverbBlend?.min).toBe(0);
    expect(spaceReverbMaterial.params.reverbBlend?.max).toBe(1);
    expect(spaceReverbMaterial.params.reverbSize?.min).toBe(0.5);
    expect(spaceReverbMaterial.params.reverbSize?.max).toBe(2);
    expect(spaceReverbMaterial.params.reverbPreDelay?.unit).toBe('ms');
    expect(spaceReverbMaterial.params.reverbPreDelay?.max).toBe(100);
    expect(spaceReverbMaterial.params.reverbTone?.default).toBe(0.7);
    expect(spaceReverbMaterial.params.reverbGate?.unit).toBe('bool');
  });

  it('is a seam kernel on its own slot', () => {
    const voice = compileVoice(spaceReverbMaterial.graph);
    expect(voice.seamSlots).toEqual([SPACE_REVERB_KERNEL_SLOT]);
    expect(voice.sourceSlot).toBeNull();
  });

  it('passes audio through when the engine has not loaded', () => {
    const voice = compileVoice(spaceReverbMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, spaceReverbMaterial.snapshotParams());
    for (const sample of [0.3, -0.5, 0.9, 0, -1]) {
      state.params.input = sample;
      expect(voice.renderSample(state, SR)).toBeCloseTo(sample, 10);
    }
  });
});
