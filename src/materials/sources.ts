import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { env, filter, impulse, noise, osc, samplePlay, uniform, wavetable } from '../asl/builders';
import type { SampleBox } from '../asl/types';
import type { AudioAssetData } from '../graph/assets';

export function sineTable(length = 1024): Float32Array {
  const table = new Float32Array(length);
  for (let i = 0; i < length; i++) table[i] = Math.sin((2 * Math.PI * i) / length);
  return table;
}

export const WAVETABLE_FRAME_SIZE = 256;

function fillFrame(table: Float32Array, frame: number, sample: (phase: number) => number): void {
  const base = frame * WAVETABLE_FRAME_SIZE;
  for (let i = 0; i < WAVETABLE_FRAME_SIZE; i++) {
    table[base + i] = sample(i / WAVETABLE_FRAME_SIZE);
  }
}

/** Eight single-cycle frames: sine, triangle, saw, square, pulse, organ, metallic, bright. */
export function wavetableBank(): Float32Array {
  const table = new Float32Array(8 * WAVETABLE_FRAME_SIZE);
  fillFrame(table, 0, (phase) => Math.sin(2 * Math.PI * phase));
  fillFrame(table, 1, (phase) => (phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase));
  fillFrame(table, 2, (phase) => 2 * phase - 1);
  fillFrame(table, 3, (phase) => (phase < 0.5 ? 1 : -1));
  fillFrame(table, 4, (phase) => (phase < 0.25 ? 1 : -1));
  fillFrame(table, 5, (phase) => {
    const a = Math.sin(2 * Math.PI * phase);
    const b = Math.sin(6 * Math.PI * phase) * 0.45;
    const c = Math.sin(10 * Math.PI * phase) * 0.2;
    return (a + b + c) / 1.65;
  });
  fillFrame(table, 6, (phase) => {
    let sum = 0;
    let norm = 0;
    for (let harmonic = 1; harmonic <= 8; harmonic++) {
      const amp = 1 / harmonic;
      sum += amp * Math.sin(2 * Math.PI * phase * harmonic);
      norm += amp;
    }
    return sum / norm;
  });
  fillFrame(table, 7, (phase) => {
    let sum = 0;
    let norm = 0;
    for (let harmonic = 1; harmonic <= 16; harmonic++) {
      const amp = 1 / Math.sqrt(harmonic);
      sum += amp * Math.sin(2 * Math.PI * phase * harmonic);
      norm += amp;
    }
    return sum / norm;
  });
  return table;
}

export const OSC_WAVE_NAMES = [
  'Sine',
  'Saw',
  'Square',
  'Triangle',
  'Pulse',
  'VarShape',
  'SuperSquare',
  'Harmonic',
] as const;

/** Note-driven oscillator. Wave type and shapeMod are live, matching the homecrate synth osc. */
export const oscillatorMaterial = new Material({
  name: 'Oscillator',
  kind: 'oscillator',
  params: {
    type: param.enum(OSC_WAVE_NAMES, { default: 'Saw', label: 'Wave' }),
    width: param.range(0, 1, { default: 0.5, label: 'Shape' }),
    octave: param.stepped(-2, 2, { default: 0, step: 1, label: 'Octave' }),
    detune: param.range(-100, 100, { default: 0, unit: 'ct', label: 'Detune' }),
    gain: param.range(0, 1, { default: 0.4 }),
  },
  automatable: ['gain', 'width', 'octave', 'detune'],
  polyphony: 8,
  voiceStealing: 'oldest',
  graph: ({ note, velocity, params }) => {
    const freq = uniform(note).add(params.octave.mul(12)).add(params.detune.mul(0.01)).toFrequency();
    const amp = env.adsr({ a: 0.005, d: 0.08, s: 0.7, r: 0.2 }).trigger(velocity);
    return osc({ freq, type: params.type, width: params.width }).mul(amp).mul(params.gain);
  },
});

export const NOISE_COLOR_NAMES = ['White', 'Pink', 'Brown', 'Blue', 'Violet', 'Grey'] as const;

export const noiseMaterial = new Material({
  name: 'Noise',
  kind: 'noise',
  params: {
    color: param.enum(NOISE_COLOR_NAMES, { default: 'White', label: 'Color' }),
    gain: param.range(0, 1, { default: 0.2 }),
    cutoff: param.range(80, 16000, { default: 4000, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['gain', 'cutoff'],
  graph: ({ params }) => filter.lowpass(noise({ color: params.color }), { cutoff: params.cutoff, q: 0.7 }).mul(params.gain),
});

/**
 * Free-running sine. `oscillator` is a keyboard voice (silent without a
 * gate). This one makes sound on Play, and `freq` is a CV jack.
 */
export const toneMaterial = new Material({
  name: 'Tone',
  kind: 'tone',
  params: {
    freq: param.range(20, 4000, { default: 220, unit: 'Hz', curve: 'log' }),
    gain: param.range(0, 1, { default: 0.22 }),
  },
  automatable: ['freq', 'gain'],
  graph: ({ params }) => osc({ freq: params.freq, type: 'sine' }).mul(params.gain),
});

export const impulseMaterial = new Material({
  name: 'Impulse',
  kind: 'impulse',
  graph: ({ input }) => impulse({ gate: input }),
});

const wavetableBoxes = new WeakMap<Material, SampleBox>();

export function createWavetableMaterial(): Material {
  const box: SampleBox = { samples: wavetableBank(), sampleRate: 48000 };
  const material = new Material({
    name: 'Wavetable',
    kind: 'wavetable',
    params: {
      position: param.range(0, 1, { default: 0.28, label: 'Position' }),
      octave: param.stepped(-2, 2, { default: 0, step: 1, label: 'Octave' }),
      detune: param.range(-100, 100, { default: 0, unit: 'ct', label: 'Detune' }),
      gain: param.range(0, 1, { default: 0.4 }),
      attack: param.range(0.001, 2, { default: 0.005, unit: 's', curve: 'exp' }),
      decay: param.range(0.001, 2, { default: 0.08, unit: 's', curve: 'exp' }),
      sustain: param.range(0, 1, { default: 0.7 }),
      release: param.range(0.001, 4, { default: 0.2, unit: 's', curve: 'exp' }),
    },
    automatable: ['position', 'octave', 'detune', 'gain', 'attack', 'release'],
    polyphony: 8,
    voiceStealing: 'oldest',
    graph: ({ note, velocity, params }) => {
      const freq = uniform(note).add(params.octave.mul(12)).add(params.detune.mul(0.01)).toFrequency();
      const amp = env
        .dahdsr({
          attack: params.attack,
          decay: params.decay,
          sustain: params.sustain,
          release: params.release,
        })
        .mul(velocity);
      return wavetable({
        freq,
        box,
        position: params.position,
        frameSize: WAVETABLE_FRAME_SIZE,
      })
        .mul(amp)
        .mul(params.gain);
    },
  });
  wavetableBoxes.set(material, box);
  return material;
}

export const wavetableMaterial = createWavetableMaterial();

export const WAVETABLE_ASSET = 'wavetable';

export function setWavetable(material: Material, samples: Float32Array, sampleRate = 48000): void {
  const box = wavetableBoxes.get(material);
  if (box) {
    box.samples = samples;
    box.sampleRate = sampleRate;
  }
}

export function setWavetableAsset(material: Material, asset: AudioAssetData): void {
  material.setAsset(WAVETABLE_ASSET, asset);
  setWavetable(material, asset.samples, asset.sampleRate);
}

export function clearWavetableAsset(material: Material): void {
  material.clearAsset(WAVETABLE_ASSET);
  setWavetable(material, wavetableBank(), 48000);
}

export function wavetableAsset(material: Material): AudioAssetData | undefined {
  return material.getAsset<AudioAssetData>(WAVETABLE_ASSET);
}

const sampleBoxes = new WeakMap<Material, SampleBox>();

export const SAMPLE_ASSET = 'sample';

export function createSamplePlayerMaterial(): Material {
  const box: SampleBox = { samples: new Float32Array(0), sampleRate: 48000 };
  const material = new Material({
    name: 'SamplePlayer',
    kind: 'sampleplayer',
    params: {
      rate: param.range(0.25, 4, { default: 1 }),
      start: param.range(0, 1, { default: 0, label: 'Start' }),
      loop: param.toggle({ default: false, labels: ['One-shot', 'Loop'] }),
      pitch: param.range(-12, 12, { default: 0, unit: 'st', label: 'Pitch' }),
      gain: param.range(0, 2, { default: 0.85 }),
    },
    automatable: ['rate', 'start', 'pitch', 'gain', 'loop'],
    graph: ({ input, params }) =>
      samplePlay({
        rate: params.rate,
        gate: input,
        position: params.start,
        loop: params.loop,
        pitch: params.pitch,
        box,
      }).mul(params.gain),
  });
  sampleBoxes.set(material, box);
  return material;
}

export const samplePlayerMaterial = createSamplePlayerMaterial();

export function setSampleAsset(material: Material, asset: AudioAssetData): void {
  material.setAsset(SAMPLE_ASSET, asset);
  const box = sampleBoxes.get(material);
  if (box) {
    box.samples = asset.samples;
    box.sampleRate = asset.sampleRate;
  }
}

export function clearSampleAsset(material: Material): void {
  material.clearAsset(SAMPLE_ASSET);
  const box = sampleBoxes.get(material);
  if (box) {
    box.samples = new Float32Array(0);
    box.sampleRate = 48000;
  }
}

export function sampleAsset(material: Material): AudioAssetData | undefined {
  return material.getAsset<AudioAssetData>(SAMPLE_ASSET);
}
