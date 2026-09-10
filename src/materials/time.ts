import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { createLooperBox, grain, looper, pitchShift, reverse } from '../asl/builders';
import { tap } from '../asl/analysis';
import type { SampleBox } from '../asl/types';
import type { AudioAssetData } from '../graph/assets';

export const reverseMaterial = new Material({
  name: 'Reverse',
  kind: 'reverse',
  params: {
    timeSec: param.range(0.01, 2, { default: 0.25, unit: 's', curve: 'exp' }),
  },
  automatable: ['timeSec'],
  graph: ({ input, params }) => reverse(input, { timeSec: params.timeSec, maxTimeSec: 2 }),
});

export const LOOPER_QUANTIZE_NAMES = ['Free', 'Beat', 'Bar'] as const;
export const LOOPER_LENGTH_PRESETS = [0, 2, 4, 8] as const;
export const LOOPER_MAX_TIME_SEC = 32;
export const LOOPER_OUTPUTS = ['audio', 'start', 'end'] as const;
export const LOOPER_START_TAP = 'start';
export const LOOPER_END_TAP = 'end';

export function isLooperKind(kind: string): boolean {
  return kind === 'looper';
}

export function isLooperPulseOutput(output: string): boolean {
  return output === 'start' || output === 'end';
}

export const looperMaterial = new Material({
  name: 'Looper',
  kind: 'looper',
  params: {
    record: param.toggle({ default: false, labels: ['Off', 'Record'] }),
    play: param.toggle({ default: true, labels: ['Stop', 'Play'] }),
    overdub: param.toggle({ default: false, labels: ['Off', 'Overdub'] }),
    undo: param.toggle({ default: false, labels: ['Ready', 'Undo'] }),
    length: param.stepped(0, 16, { default: 0, step: 1, label: 'Bars' }),
    threshold: param.range(0, 1, { default: 0, label: 'Threshold' }),
    quantize: param.enum(LOOPER_QUANTIZE_NAMES, { default: 'Free', label: 'Quantize' }),
    clear: param.toggle({ default: false, labels: ['Ready', 'Clear'] }),
    mix: param.range(0, 1, { default: 1 }),
  },
  automatable: ['record', 'play', 'overdub', 'undo', 'length', 'threshold', 'quantize', 'mix', 'clear'],
  graph: ({ input, params }) => {
    const box = createLooperBox();
    const opts = {
      record: params.record,
      play: params.play,
      overdub: params.overdub,
      undo: params.undo,
      bars: params.length,
      clear: params.clear,
      threshold: params.threshold,
      quantize: params.quantize,
      fadeSec: 0.008,
      maxTimeSec: LOOPER_MAX_TIME_SEC,
      box,
    };
    const wet = looper(input, { ...opts, field: 'audio' });
    const start = looper(input, { ...opts, field: 'start' });
    const end = looper(input, { ...opts, field: 'end' });
    const mixed = input.mul(params.mix.mul(-1).add(1)).add(wet.mul(params.mix));
    return mixed
      .add(tap.meter(start, { id: LOOPER_START_TAP }).mul(0))
      .add(tap.meter(end, { id: LOOPER_END_TAP }).mul(0));
  },
});

export const pitchShiftMaterial = new Material({
  name: 'PitchShift',
  kind: 'pitchshift',
  params: {
    pitch: param.range(-12, 12, { default: 0, unit: 'st', label: 'Pitch' }),
    mix: param.range(0, 1, { default: 1 }),
  },
  automatable: ['pitch', 'mix'],
  graph: ({ input, params }) => {
    const wet = pitchShift(input, { pitch: params.pitch, unit: 'st' });
    return input.mul(params.mix.mul(-1).add(1)).add(wet.mul(params.mix));
  },
});

const grainBoxes = new WeakMap<Material, SampleBox>();

export function createGrainMaterial(): Material {
  const box: SampleBox = { samples: new Float32Array(0), sampleRate: 48000 };
  const material = new Material({
    name: 'Grain',
    kind: 'grain',
    params: {
      duration: param.range(0.01, 0.2, { default: 0.04, unit: 's', curve: 'exp' }),
      position: param.range(0, 1, { default: 0 }),
      rate: param.range(0.25, 4, { default: 1 }),
    },
    automatable: ['duration', 'position', 'rate'],
    graph: ({ input, params }) =>
      grain(input, {
        duration: params.duration,
        position: params.position,
        rate: params.rate,
        box,
      }),
  });
  grainBoxes.set(material, box);
  return material;
}

export const grainMaterial = createGrainMaterial();

export function setGrainAsset(material: Material, asset: AudioAssetData): void {
  const box = grainBoxes.get(material);
  if (box) {
    box.samples = asset.samples;
    box.sampleRate = asset.sampleRate;
  }
}
