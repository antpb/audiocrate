import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../../src/asl/compile';
import { synthPluginMaterial, synthParams } from './synthMaterial';
import { SYNTH_KERNEL_SLOT } from './kernelSlot';

const SR = 48000;

describe('synthPluginMaterial', () => {
  it('declares the 162 AUv3 addresses', () => {
    expect(Object.keys(synthParams)).toHaveLength(162);
    expect(synthPluginMaterial.automatable).toHaveLength(162);
    expect(synthPluginMaterial.params.oscAWaveform?.address).toBe(0);
    expect(synthPluginMaterial.params.oscMasterLevel?.address).toBe(9);
    expect(synthPluginMaterial.params.filterBSlope?.address).toBe(316);
  });

  it('is a source kernel that ignores its input entirely', () => {
    const voice = compileVoice(synthPluginMaterial.graph);
    expect(voice.sourceSlot).toBe(SYNTH_KERNEL_SLOT);
  });

  it('is silent with no engine loaded, rather than passing audio through', () => {
    // An instrument has no input to pass. Zero is its honest output; leaking
    // whatever happened to be on the bus would be a routing bug.
    const voice = compileVoice(synthPluginMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, synthPluginMaterial.snapshotParams());
    const out = new Float32Array(4);
    voice.renderBlock(state, SR, out, Float32Array.from([0.42, 0.42, 0.42, 0.42]));
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });

  it('generates from a bound engine', () => {
    const voice = compileVoice(synthPluginMaterial.graph);
    const state = voice.createState();
    state.kernels = new Map([
      [SYNTH_KERNEL_SLOT, { processSource: (_l: unknown, _r: unknown, outL: Float32Array) => outL.fill(0.3) }],
    ]);
    voice.noteOn(state, synthPluginMaterial.snapshotParams());
    const out = new Float32Array(3);
    voice.renderBlock(state, SR, out);
    expect(Array.from(out)).toEqual(Array.from(Float32Array.from([0.3, 0.3, 0.3])));
  });
});
