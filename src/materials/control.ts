import { Material } from '../graph/Material';
import { param } from '../graph/param';

import {
  clock,
  clockDivide,
  clockMultiply,
  compare,
  env,
  euclidean,
  flipFlop,
  lfo,
  logic,
  pulse,
  quantize,
  random,
  sampleHold,
  sequencer,
  slew,
  trigger,
} from '../asl/builders';
import { QUANTIZE_SCALE_NAMES } from '../asl/controlMath';
import { OSC_WAVE_NAMES } from './sources';

/** Pitch classes in semitone order, so a root param reads as a note name. */
export const PITCH_CLASSES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

export const slewMaterial = new Material({
  name: 'Slew',
  kind: 'slew',
  params: {
    rise: param.range(0, 10000, { default: 10, unit: '/s' }),
    fall: param.range(0, 10000, { default: 10, unit: '/s' }),
  },
  automatable: ['rise', 'fall'],
  graph: ({ input, params }) => slew(input, { rise: params.rise, fall: params.fall }),
});

export const sampleHoldMaterial = new Material({
  name: 'SampleHold',
  kind: 'samplehold',
  params: {
    freq: param.range(0.1, 20000, { default: 20, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['freq'],
  graph: ({ input, params }) => sampleHold(input, { freq: params.freq }),
});

export const compareGreaterMaterial = new Material({
  name: 'CompareGreater',
  kind: 'comparegt',
  params: {
    threshold: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['threshold'],
  graph: ({ input, params }) => compare(input, { threshold: params.threshold, mode: 'gt' }),
});

export const compareLessMaterial = new Material({
  name: 'CompareLess',
  kind: 'comparelt',
  params: {
    threshold: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['threshold'],
  graph: ({ input, params }) => compare(input, { threshold: params.threshold, mode: 'lt' }),
});

export const clockMaterial = new Material({
  name: 'Clock',
  kind: 'clock',
  params: {
    freq: param.range(0.1, 40, { default: 2, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['freq'],
  cvPolarity: 'unipolar',
  graph: ({ params }) => clock({ freq: params.freq }),
});

export const clockDivideMaterial = new Material({
  name: 'ClockDivide',
  kind: 'clockdivide',
  params: {
    factor: param.stepped(1, 64, { step: 1, default: 2 }),
  },
  automatable: ['factor'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) => clockDivide(input, { factor: params.factor }),
});

export const clockMultiplyMaterial = new Material({
  name: 'ClockMultiply',
  kind: 'clockmultiply',
  params: {
    factor: param.stepped(1, 16, { step: 1, default: 2 }),
  },
  automatable: ['factor'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) => clockMultiply(input, { factor: params.factor }),
});

export const logicAndMaterial = new Material({
  name: 'LogicAnd',
  kind: 'logicand',
  params: {
    other: param.range(0, 1, { default: 1 }),
  },
  automatable: ['other'],
  graph: ({ input, params }) => logic.and(input, params.other),
});

export const logicOrMaterial = new Material({
  name: 'LogicOr',
  kind: 'logicor',
  params: {
    other: param.range(0, 1, { default: 0 }),
  },
  automatable: ['other'],
  graph: ({ input, params }) => logic.or(input, params.other),
});

export const logicXorMaterial = new Material({
  name: 'LogicXor',
  kind: 'logicxor',
  params: {
    other: param.range(0, 1, { default: 0 }),
  },
  automatable: ['other'],
  graph: ({ input, params }) => logic.xor(input, params.other),
});

export const logicNotMaterial = new Material({
  name: 'LogicNot',
  kind: 'logicnot',
  graph: ({ input }) => logic.not(input),
});

export const flipFlopMaterial = new Material({
  name: 'FlipFlop',
  kind: 'flipflop',
  graph: ({ input }) => flipFlop(input),
});

export const quantizeMaterial = new Material({
  name: 'Quantize',
  kind: 'quantize',
  params: {
    root: param.enum(PITCH_CLASSES, { default: 'C', label: 'Root' }),
    // Order is QUANTIZE_SCALES order. The value stays the same index it was
    // when this was a range, so a saved project reads back identically.
    scale: param.enum(QUANTIZE_SCALE_NAMES, {
      default: 'major',
      label: 'Scale',
    }),
  },
  automatable: ['root', 'scale'],
  graph: ({ input, params }) => quantize(input, { root: params.root, scale: params.scale }),
});

export const euclideanMaterial = new Material({
  name: 'Euclidean',
  kind: 'euclidean',
  params: {
    steps: param.stepped(1, 32, { step: 1, default: 8 }),
    hits: param.stepped(0, 32, { step: 1, default: 3 }),
    rotation: param.stepped(0, 31, { step: 1, default: 0 }),
  },
  automatable: ['steps', 'hits', 'rotation'],
  graph: ({ input, params }) =>
    euclidean(input, { steps: params.steps, hits: params.hits, rotation: params.rotation }),
});

export const randomSteppedMaterial = new Material({
  name: 'RandomStepped',
  kind: 'randomstepped',
  params: {
    freq: param.range(0.1, 40, { default: 8, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['freq'],
  graph: ({ params }) => random({ freq: params.freq, mode: 'stepped' }),
});

export const randomSmoothMaterial = new Material({
  name: 'RandomSmooth',
  kind: 'randomsmooth',
  params: {
    freq: param.range(0.1, 40, { default: 4, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['freq'],
  graph: ({ params }) => random({ freq: params.freq, mode: 'smooth' }),
});

export const triggerMaterial = new Material({
  name: 'Trigger',
  kind: 'trigger',
  params: {
    threshold: param.range(-1, 1, { default: 0.5 }),
  },
  automatable: ['threshold'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) => trigger(input, { threshold: params.threshold }),
});

export const pulseMaterial = new Material({
  name: 'Pulse',
  kind: 'pulse',
  params: {
    widthSec: param.range(0.001, 2, { default: 0.01, unit: 's', curve: 'exp' }),
  },
  automatable: ['widthSec'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) => pulse(input, { widthSec: params.widthSec }),
});

export const sequencerMaterial = new Material({
  name: 'Sequencer',
  kind: 'sequencer',
  params: {
    step0: param.range(-1, 1, { default: 0 }),
    step1: param.range(-1, 1, { default: 0.25 }),
    step2: param.range(-1, 1, { default: 0.5 }),
    step3: param.range(-1, 1, { default: 0.75 }),
    step4: param.range(-1, 1, { default: 1 }),
    step5: param.range(-1, 1, { default: 0.75 }),
    step6: param.range(-1, 1, { default: 0.5 }),
    step7: param.range(-1, 1, { default: 0.25 }),
  },
  automatable: ['step0', 'step1', 'step2', 'step3', 'step4', 'step5', 'step6', 'step7'],
  graph: ({ input, params }) =>
    sequencer(input, [
      params.step0,
      params.step1,
      params.step2,
      params.step3,
      params.step4,
      params.step5,
      params.step6,
      params.step7,
    ]),
});

/**
 * Note-driven envelope for cabling into another Material's params.
 * Times are live (dahdsr under the hood). Gate is the voice gate, so a
 * Keyboard note / gate cable allocates voices the same way an oscillator does.
 */
export const adsrMaterial = new Material({
  name: 'ADSR',
  kind: 'adsr',
  params: {
    attack: param.range(0.001, 2, { default: 0.01, unit: 's', curve: 'exp' }),
    decay: param.range(0.001, 2, { default: 0.12, unit: 's', curve: 'exp' }),
    sustain: param.range(0, 1, { default: 0.7 }),
    release: param.range(0.001, 4, { default: 0.25, unit: 's', curve: 'exp' }),
    amount: param.range(0, 1, { default: 1 }),
  },
  automatable: ['attack', 'decay', 'sustain', 'release', 'amount'],
  polyphony: 8,
  channels: 1,
  cvPolarity: 'unipolar',
  graph: ({ velocity, params }) =>
    env
      .dahdsr({
        attack: params.attack,
        decay: params.decay,
        sustain: params.sustain,
        release: params.release,
      })
      .mul(velocity)
      .mul(params.amount),
});

export const dahdsrMaterial = new Material({
  name: 'DAHDSR',
  kind: 'dahdsr',
  params: {
    delay: param.range(0, 2, { default: 0, unit: 's', curve: 'exp' }),
    attack: param.range(0.001, 2, { default: 0.005, unit: 's', curve: 'exp' }),
    hold: param.range(0, 2, { default: 0, unit: 's', curve: 'exp' }),
    decay: param.range(0.001, 2, { default: 0.1, unit: 's', curve: 'exp' }),
    sustain: param.range(0, 1, { default: 0.7 }),
    release: param.range(0.001, 4, { default: 0.2, unit: 's', curve: 'exp' }),
  },
  automatable: ['delay', 'attack', 'hold', 'decay', 'sustain', 'release'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) =>
    env.dahdsr({
      delay: params.delay,
      attack: params.attack,
      hold: params.hold,
      decay: params.decay,
      sustain: params.sustain,
      release: params.release,
      gate: input,
    }),
});

export const offsetMaterial = new Material({
  name: 'Offset',
  kind: 'offset',
  params: {
    amount: param.range(-2, 2, { default: 0 }),
  },
  automatable: ['amount'],
  graph: ({ input, params }) => input.add(params.amount),
});

export const controlMaterial = new Material({
  name: 'Control',
  kind: 'control',
  params: {
    value: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['value'],
  graph: ({ params }) => params.value,
});

export const lfoMaterial = new Material({
  name: 'LFO',
  kind: 'lfo',
  params: {
    type: param.enum(OSC_WAVE_NAMES, { default: 'Sine', label: 'Wave' }),
    width: param.range(0, 1, { default: 0.5, label: 'Shape' }),
    rate: param.range(0.05, 20, { default: 0.4, unit: 'Hz', curve: 'log' }),
    amount: param.range(0, 1, { default: 0.35 }),
  },
  automatable: ['rate', 'amount', 'width'],
  channels: 1,
  cvPolarity: 'bipolar',
  graph: ({ params }) =>
    lfo({ rate: params.rate, shape: params.type, width: params.width }).mul(params.amount),
});

export const breakpointEnvelopeMaterial = new Material({
  name: 'BreakpointEnvelope',
  kind: 'breakpoints',
  params: {
    time0: param.range(0, 4, { default: 0, unit: 's', curve: 'exp', label: 'Time 1' }),
    time1: param.range(0, 4, { default: 0.01, unit: 's', curve: 'exp', label: 'Time 2' }),
    time2: param.range(0, 4, { default: 0.12, unit: 's', curve: 'exp', label: 'Time 3' }),
    time3: param.range(0, 4, { default: 0.4, unit: 's', curve: 'exp', label: 'Time 4' }),
    level0: param.range(0, 1, { default: 0, label: 'Level 1' }),
    level1: param.range(0, 1, { default: 1, label: 'Level 2' }),
    level2: param.range(0, 1, { default: 0.6, label: 'Level 3' }),
    level3: param.range(0, 1, { default: 0, label: 'Level 4' }),
  },
  automatable: ['time0', 'time1', 'time2', 'time3', 'level0', 'level1', 'level2', 'level3'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) =>
    env.breakpoints({
      times: [params.time0, params.time1, params.time2, params.time3],
      levels: [params.level0, params.level1, params.level2, params.level3],
      gate: input,
    }),
});
