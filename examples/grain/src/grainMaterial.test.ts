import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../../src/asl/compile';
import { grainMaterial, grainParams } from './grainMaterial';
import { GRAIN_KERNEL_SLOT } from './kernelSlot';

const SR = 48000;

describe('grainMaterial', () => {
  it('declares the 79 AUv3 addresses', () => {
    expect(Object.keys(grainParams)).toHaveLength(79);
    expect(grainMaterial.automatable).toHaveLength(79);
    expect(grainMaterial.params.inputGain?.address).toBe(0);
    expect(grainMaterial.params.grainMix?.address).toBe(30);
    expect(grainMaterial.params.grainLfoDepth?.address).toBe(125);
  });

  it('is a source kernel on its own slot, since the engine is the whole processor', () => {
    const voice = compileVoice(grainMaterial.graph);
    expect(voice.sourceSlot).toBe(GRAIN_KERNEL_SLOT);
    expect(voice.seamSlots).toEqual([]);
  });

  it('passes audio through untouched when the engine has not loaded', () => {
    // An insert whose WASM never arrived must stay audible. Silence here would
    // mute a whole track for a load failure the user cannot see.
    const voice = compileVoice(grainMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, grainMaterial.snapshotParams());
    const out = new Float32Array(4);
    voice.renderBlock(state, SR, out, Float32Array.from([0.42, -0.42, 0.1, 0]));
    expect(Array.from(out)).toEqual(Array.from(Float32Array.from([0.42, -0.42, 0.1, 0])));
  });

  it('routes the block through a bound engine, both channels', () => {
    const voice = compileVoice(grainMaterial.graph);
    const state = voice.createState();
    state.kernels = new Map([
      [
        GRAIN_KERNEL_SLOT,
        {
          processSource(inL: Float32Array, _inR: unknown, outL: Float32Array, outR: Float32Array | null) {
            for (let i = 0; i < inL.length; i++) outL[i] = inL[i]! * 2;
            outR?.fill(-1);
          },
        },
      ],
    ]);
    voice.noteOn(state, grainMaterial.snapshotParams());
    const outL = new Float32Array(2);
    const outR = new Float32Array(2);
    voice.renderBlock(state, SR, outL, Float32Array.from([0.25, 0.5]), { outputR: outR });
    expect(Array.from(outL)).toEqual([0.5, 1]);
    expect(Array.from(outR)).toEqual([-1, -1]);
  });
});
