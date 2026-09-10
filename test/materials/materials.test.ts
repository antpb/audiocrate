import { describe, expect, it } from 'vitest';
import { synthVoiceMaterial } from '../../src/materials/synthVoice';
import { parametricEqMaterial } from '../../src/materials/parametricEq';
import { gainMaterial } from '../../src/materials/gain';
import { invertMaterial } from '../../src/materials/invert';
import { highpassMaterial, lowShelfMaterial, onePoleLowpassMaterial } from '../../src/materials/filters';
import { delayMaterial } from '../../src/materials/delay';
import { reverbMaterial } from '../../src/materials/reverb';
import { bitcrushMaterial, waveshapeMaterial } from '../../src/materials/nonlinear';
import { compressorMaterial, gateMaterial, limiterMaterial } from '../../src/materials/dynamics';
import { bypassMaterial } from '../../src/materials/bypass';
import {
  adsrMaterial,
  breakpointEnvelopeMaterial,
  clockMaterial,
  lfoMaterial,
  offsetMaterial,
  quantizeMaterial,
  slewMaterial,
} from '../../src/materials/control';
import { looperMaterial, pitchShiftMaterial } from '../../src/materials/time';
import { transportMaterial } from '../../src/materials/transport';
import { mixMaterial, panLeftMaterial } from '../../src/materials/routing';
import { expanderMaterial } from '../../src/materials/dynamics';
import {
  createSamplePlayerMaterial,
  createWavetableMaterial,
  impulseMaterial,
  setSampleAsset,
  setWavetableAsset,
  wavetableAsset,
  wavetableBank,
  toneMaterial,
} from '../../src/materials/sources';
import { createIrMaterial, setIrAsset, irLatencySamples } from '../../src/materials/ir';
import { irPlugin } from '../../src/materials/irPlugin';
import { compileVoice } from '../../src/asl/compile';
import type { AudioAssetData } from '../../src/graph/assets';

const SR = 48000;

describe('synthVoiceMaterial', () => {
  it('declares a subtractive voice: wave, filter, and amp envelope', () => {
    expect(synthVoiceMaterial.params.type).toBeDefined();
    expect(synthVoiceMaterial.params.unison).toBeDefined();
    expect(synthVoiceMaterial.params.attack).toBeDefined();
    expect(synthVoiceMaterial.getParam('cutoff')).toBe(2000);
    expect(synthVoiceMaterial.getParam('resonance')).toBe(0.8);
    expect(synthVoiceMaterial.getParam('gain')).toBe(0.7);
  });

  it('renders finite, bounded audio across a full note-on/note-off cycle', () => {
    const voice = compileVoice(synthVoiceMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { note: 69, velocity: 0.9, ...synthVoiceMaterial.snapshotParams() });

    const held = new Float32Array(Math.round(0.3 * SR));
    voice.renderBlock(state, SR, held);
    voice.noteOff(state);
    const release = new Float32Array(Math.round(0.4 * SR));
    voice.renderBlock(state, SR, release);

    for (const sample of [...held, ...release]) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(Math.abs(sample)).toBeLessThanOrEqual(1.1);
    }
    expect(release[release.length - 1]).toBeCloseTo(0, 1);
  });

  it('a different cutoff param value audibly changes the rendered output', () => {
    function renderWithCutoff(cutoff: number): Float32Array {
      const voice = compileVoice(synthVoiceMaterial.graph);
      const state = voice.createState();
      voice.noteOn(state, { note: 69, velocity: 0.9, ...synthVoiceMaterial.snapshotParams(), cutoff });
      voice.renderBlock(state, SR, new Float32Array(200)); // discard onset transient
      const block = new Float32Array(500);
      voice.renderBlock(state, SR, block);
      return block;
    }

    const dark = renderWithCutoff(300);
    const bright = renderWithCutoff(6000);
    let differs = false;
    for (let i = 0; i < dark.length; i++) {
      if (Math.abs(dark[i]! - bright[i]!) > 1e-6) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });
});

describe('parametricEqMaterial', () => {
  it('declares the channel-EQ band params', () => {
    expect(parametricEqMaterial.params.lowMidFreq).toBeDefined();
    expect(parametricEqMaterial.params.highGain).toBeDefined();
    expect(parametricEqMaterial.getParam('lowMidGain')).toBe(0);
    expect(parametricEqMaterial.getParam('hpOn')).toBe(0);
    expect(parametricEqMaterial.getParam('lpOn')).toBe(0);
  });

  it('is an exact bypass at 0dB with filters off: output equals whatever is fed into `input`', () => {
    const voice = compileVoice(parametricEqMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, parametricEqMaterial.snapshotParams());

    for (const sample of [0.3, -0.5, 0.9, 0, -1]) {
      state.params.input = sample;
      expect(voice.renderSample(state, SR)).toBeCloseTo(sample, 10);
    }
  });

  it('boosts a signal at the target frequency when a mid band is positive', () => {
    function rmsAtFreq(gainDb: number, freq: number, signalFreq: number): number {
      const voice = compileVoice(parametricEqMaterial.graph);
      const state = voice.createState();
      voice.noteOn(state, { ...parametricEqMaterial.snapshotParams(), lowMidFreq: freq, lowMidGain: gainDb, lowMidQ: 1 });

      const block = new Float32Array(2000);
      for (let i = 0; i < block.length; i++) {
        state.params.input = Math.sin((2 * Math.PI * signalFreq * i) / SR);
        block[i] = voice.renderSample(state, SR);
      }
      const settled = block.slice(500);
      return Math.sqrt(settled.reduce((sum, v) => sum + v * v, 0) / settled.length);
    }

    const unityRms = rmsAtFreq(0, 1000, 1000);
    const boostedRms = rmsAtFreq(12, 1000, 1000);
    expect(boostedRms).toBeGreaterThan(unityRms);
  });
});

describe('samplePlayerMaterial', () => {
  it('is silent until a sample is loaded, then plays on a gate', () => {
    const material = createSamplePlayerMaterial();
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    voice.noteOn(state, material.snapshotParams());
    state.params.input = 1;
    expect(voice.renderSample(state, SR)).toBe(0);

    setSampleAsset(material, {
      filename: 'click.wav',
      samples: new Float32Array([0.5, 0.25, 0]),
      sampleRate: SR,
    });
    state.params.input = 0;
    voice.renderSample(state, SR);
    state.params.input = 1;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.5 * material.getParam('gain'), 5);
  });

  it('loops from start when loop is on', () => {
    const material = createSamplePlayerMaterial();
    setSampleAsset(material, {
      filename: 'tone.wav',
      samples: new Float32Array([0.8, 0.2, 0]),
      sampleRate: SR,
    });
    material.setParam('loop', 1);
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    voice.noteOn(state, material.snapshotParams());
    state.params.input = 1;
    const heard: number[] = [];
    for (let i = 0; i < 8; i += 1) heard.push(voice.renderSample(state, SR));
    expect(heard.some((sample) => sample !== 0)).toBe(true);
    expect(heard[heard.length - 1]).not.toBe(0);
  });
});

describe('wavetableMaterial', () => {
  it('exposes position, pitch, and an amp envelope', () => {
    const material = createWavetableMaterial();
    expect(material.getParam('position')).toBeCloseTo(0.28);
    expect(material.params.octave).toBeDefined();
    expect(material.params.attack).toBeDefined();
  });

  it('replaces the factory bank when a table file is loaded', () => {
    const material = createWavetableMaterial();
    const factory = wavetableBank();
    setWavetableAsset(material, {
      filename: 'custom.wav',
      samples: new Float32Array([0.1, 0.2, 0.3]),
      sampleRate: 44100,
    });
    expect(wavetableAsset(material)?.filename).toBe('custom.wav');
    expect(factory[0]).not.toBeCloseTo(0.1);
  });
});

describe('waveshapeMaterial', () => {
  it('is dry at mix 0', () => {
    const voice = compileVoice(waveshapeMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { ...waveshapeMaterial.snapshotParams(), mix: 0, drive: 8 });
    state.params.input = 0.37;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.37, 8);
  });

  it('drive changes a wet signal', () => {
    function render(drive: number): number {
      const voice = compileVoice(waveshapeMaterial.graph);
      const state = voice.createState();
      voice.noteOn(state, { ...waveshapeMaterial.snapshotParams(), drive, mix: 1, curve: 0 });
      state.params.input = 0.6;
      return voice.renderSample(state, SR);
    }
    expect(Math.abs(render(1) - render(8))).toBeGreaterThan(1e-4);
  });
});

describe('core insert materials', () => {
  it('gain at 1 is identity', () => {
    const voice = compileVoice(gainMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, gainMaterial.snapshotParams());
    state.params.input = 0.55;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.55, 10);
  });

  it('invert flips polarity', () => {
    const voice = compileVoice(invertMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    state.params.input = 0.4;
    expect(voice.renderSample(state, SR)).toBeCloseTo(-0.4, 10);
  });

  it('low shelf at 0 dB is identity', () => {
    const voice = compileVoice(lowShelfMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, lowShelfMaterial.snapshotParams());
    state.params.input = 0.2;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.2, 10);
  });

  it('delay mix 0 is identity', () => {
    const voice = compileVoice(delayMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { timeSec: 0.2, feedback: 0.4, mix: 0 });
    state.params.input = 0.11;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.11, 10);
  });

  it('reverb mix 0 is identity', () => {
    const voice = compileVoice(reverbMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, reverbMaterial.snapshotParams());
    state.params.mix = 0;
    state.params.input = 0.11;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.11, 10);
  });

  it('tone is a free-running sine', () => {
    const voice = compileVoice(toneMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { freq: 220, gain: 0.4 });
    let energy = 0;
    for (let i = 0; i < 400; i++) {
      const sample = voice.renderSample(state, SR);
      expect(Number.isFinite(sample)).toBe(true);
      energy += sample * sample;
    }
    expect(energy).toBeGreaterThan(0);
  });

  it('highpass declares cutoff and q', () => {
    expect(highpassMaterial.automatable).toEqual(['cutoff', 'q']);
  });

  it('bypass is identity', () => {
    const voice = compileVoice(bypassMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    state.params.input = 0.73;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.73, 10);
  });

  it('one-pole lowpass declares cutoff', () => {
    expect(onePoleLowpassMaterial.automatable).toEqual(['cutoff']);
  });

  it('bitcrush at 16 bits is identity on 0.5', () => {
    const voice = compileVoice(bitcrushMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { bits: 16 });
    state.params.input = 0.5;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.5, 4);
  });

  it('slew declares rise and fall', () => {
    expect(slewMaterial.automatable).toEqual(['rise', 'fall']);
  });

  it('compressor below threshold is identity', () => {
    const voice = compileVoice(compressorMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { ...compressorMaterial.snapshotParams(), threshold: 0.8, ratio: 4 });
    state.params.input = 0.2;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.2, 10);
  });

  it('compressor mix 0 is dry', () => {
    const voice = compileVoice(compressorMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { ...compressorMaterial.snapshotParams(), mix: 0, makeup: 4, threshold: 0.01 });
    state.params.input = 0.2;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.2, 10);
  });

  it('limiter declares threshold, attack, and release', () => {
    expect(limiterMaterial.automatable).toEqual(['threshold', 'attack', 'release']);
  });

  it('adsr opens on noteOn and falls after noteOff', () => {
    const voice = compileVoice(adsrMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { ...adsrMaterial.snapshotParams(), velocity: 1 });
    let peak = 0;
    for (let i = 0; i < 2400; i += 1) peak = Math.max(peak, voice.renderSample(state, SR));
    expect(peak).toBeGreaterThan(0.5);
    voice.noteOff(state);
    let last = 1;
    for (let i = 0; i < SR; i += 1) last = voice.renderSample(state, SR);
    expect(last).toBeLessThan(0.05);
    expect(adsrMaterial.cvPolarity).toBe('unipolar');
  });

  it('lfo is a bipolar control oscillator', () => {
    expect(lfoMaterial.cvPolarity).toBe('bipolar');
    expect(lfoMaterial.params.type).toBeDefined();
    const voice = compileVoice(lfoMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { ...lfoMaterial.snapshotParams(), rate: 4, amount: 1 });
    let min = 1;
    let max = -1;
    for (let i = 0; i < SR; i += 1) {
      const sample = voice.renderSample(state, SR);
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }
    expect(min).toBeLessThan(-0.1);
    expect(max).toBeGreaterThan(0.1);
  });

  it('breakpoint envelope exposes four live points', () => {
    expect(breakpointEnvelopeMaterial.getParam('time1')).toBeCloseTo(0.01);
    expect(breakpointEnvelopeMaterial.getParam('level1')).toBe(1);
  });

  it('pitch shift mix 0 is dry', () => {
    const voice = compileVoice(pitchShiftMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { ...pitchShiftMaterial.snapshotParams(), mix: 0, pitch: 7 });
    state.params.input = 0.33;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.33, 10);
  });

  it('looper mix 0 is dry', () => {
    expect(looperMaterial.params.length).toBeDefined();
    const voice = compileVoice(looperMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { ...looperMaterial.snapshotParams(), mix: 0, record: 1 });
    state.params.input = 0.41;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.41, 10);
  });

  it('offset at 0 is identity', () => {
    const voice = compileVoice(offsetMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, offsetMaterial.snapshotParams());
    state.params.input = 0.4;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.4, 10);
  });

  it('quantize snaps 61 to 60 on C major', () => {
    const voice = compileVoice(quantizeMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { root: 0, scale: 0 });
    state.params.input = 61;
    expect(voice.renderSample(state, SR)).toBe(60);
  });

  it('clock declares freq', () => {
    expect(clockMaterial.automatable).toEqual(['freq']);
  });

  it('transport publishes bpm and time signature', () => {
    expect(transportMaterial.kind).toBe('transport');
    expect(transportMaterial.getParam('bpm')).toBe(120);
    expect(transportMaterial.getParam('beatsPerBar')).toBe(4);
    expect(transportMaterial.getParam('beatUnit')).toBe(4);
    expect(transportMaterial.automatable).toEqual(['bpm', 'beatsPerBar', 'beatUnit']);
    expect(transportMaterial.cvPolarity).toBe('unipolar');
  });

  it('impulse gated low is silent after the first sample', () => {
    const voice = compileVoice(impulseMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    state.params.input = 0;
    expect(voice.renderSample(state, SR)).toBe(0);
  });

  it('mix with zero aux is identity', () => {
    const voice = compileVoice(mixMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, mixMaterial.snapshotParams());
    state.params.input = 0.4;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.4, 10);
  });

  it('pan left at center is equal-power', () => {
    const voice = compileVoice(panLeftMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { pan: 0 });
    state.params.input = 1;
    expect(voice.renderSample(state, SR)).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('expander above threshold is identity', () => {
    const voice = compileVoice(expanderMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { threshold: 0.2, ratio: 2, attack: 0.005, release: 0.05 });
    state.params.input = 0.8;
    for (let i = 0; i < 2000; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.8, 5);
  });

  it('gate below threshold silences after the envelope settles', () => {
    const voice = compileVoice(gateMaterial.graph);
    const state = voice.createState();
    voice.noteOn(state, { threshold: 0.4, attack: 0.001, release: 0.01 });
    for (let i = 0; i < 2000; i++) {
      state.params.input = 0.05;
      voice.renderSample(state, SR);
    }
    state.params.input = 0.05;
    expect(voice.renderSample(state, SR)).toBe(0);
  });
});

describe('IR material', () => {
  it('reports no mix delay: a hop-aligned process is causal', () => {
    const material = createIrMaterial();
    expect(irLatencySamples(material)).toBe(0);
    const asset: AudioAssetData = {
      filename: 'cab.wav',
      samples: new Float32Array([1, 0, 0]),
      sampleRate: SR,
    };
    setIrAsset(material, asset);
    expect(irLatencySamples(material)).toBe(0);
  });

  it('bake with no IR is a gain-only passthrough', async () => {
    const material = createIrMaterial();
    material.setParam('gain', 0.5);
    const input = new Float32Array([0.2, -0.4, 0.8]);
    const [out] = await irPlugin.bake!(material, [input], SR, {});
    expect(out![0]).toBeCloseTo(0.1, 5);
    expect(out![1]).toBeCloseTo(-0.2, 5);
    expect(out![2]).toBeCloseTo(0.4, 5);
  });

  it('unbound IR graph is a dry/wet mix of the input with itself', () => {
    const material = createIrMaterial();
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    voice.noteOn(state, { mix: 0.5, gain: 1 });
    state.params.input = 0.8;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.8, 8);
  });
});
