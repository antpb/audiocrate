import { AudioMaterial } from '../graph/AudioMaterial';
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

export const slewMaterial = new AudioMaterial({
  name: 'Slew',
  kind: 'slew',
  params: {
    rise: param.range(0, 10000, { default: 10, unit: '/s' }),
    fall: param.range(0, 10000, { default: 10, unit: '/s' }),
  },
  automatable: ['rise', 'fall'],
  graph: ({ input, params }) => slew(input, { rise: params.rise, fall: params.fall }),
});

export const sampleHoldMaterial = new AudioMaterial({
  name: 'SampleHold',
  kind: 'samplehold',
  params: {
    // Down to zero, and zero means "somebody else's clock". The internal rate
    // and an external one at the same time is two grids fighting, and the
    // graph cannot see whether a cable is attached, so the knob is what says
    // which is in charge.
    freq: param.range(0, 20000, { default: 20, unit: 'Hz', curve: 'exp' }),
    clock: param.range(0, 1, { default: 0 }),
  },
  automatable: ['freq'],
  graph: ({ input, params }) => sampleHold(input, { freq: params.freq, clock: params.clock }),
});

export const compareGreaterMaterial = new AudioMaterial({
  name: 'CompareGreater',
  kind: 'comparegt',
  params: {
    threshold: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['threshold'],
  graph: ({ input, params }) => compare(input, { threshold: params.threshold, mode: 'gt' }),
});

export const compareLessMaterial = new AudioMaterial({
  name: 'CompareLess',
  kind: 'comparelt',
  params: {
    threshold: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['threshold'],
  graph: ({ input, params }) => compare(input, { threshold: params.threshold, mode: 'lt' }),
});

export const clockMaterial = new AudioMaterial({
  name: 'Clock',
  kind: 'clock',
  params: {
    freq: param.range(0.1, 40, { default: 2, unit: 'Hz', curve: 'log' }),
    // A jack, not a knob, which is why it is not automatable and why it is
    // last: parameter order is declaration order and flatten hands out
    // addresses along it, so appending leaves every existing address alone.
    //
    // Patch the Transport's `playing` here and the clock starts with the
    // song. Without it a free-running clock is wherever it happens to be
    // when Play arrives, and the pattern sits off the bar for as long as the
    // plugin stays loaded.
    reset: param.range(0, 1, { default: 0 }),
  },
  automatable: ['freq'],
  cvPolarity: 'unipolar',
  graph: ({ params }) => clock({ freq: params.freq, reset: params.reset }),
});

export const clockDivideMaterial = new AudioMaterial({
  name: 'ClockDivide',
  kind: 'clockdivide',
  params: {
    factor: param.stepped(1, 64, { step: 1, default: 2 }),
    reset: param.range(0, 1, { default: 0 }),
  },
  automatable: ['factor'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) => clockDivide(input, { factor: params.factor, reset: params.reset }),
});

export const clockMultiplyMaterial = new AudioMaterial({
  name: 'ClockMultiply',
  kind: 'clockmultiply',
  params: {
    factor: param.stepped(1, 16, { step: 1, default: 2 }),
    reset: param.range(0, 1, { default: 0 }),
  },
  automatable: ['factor'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) => clockMultiply(input, { factor: params.factor, reset: params.reset }),
});

export const logicAndMaterial = new AudioMaterial({
  name: 'LogicAnd',
  kind: 'logicand',
  params: {
    other: param.range(0, 1, { default: 1 }),
  },
  automatable: ['other'],
  graph: ({ input, params }) => logic.and(input, params.other),
});

export const logicOrMaterial = new AudioMaterial({
  name: 'LogicOr',
  kind: 'logicor',
  params: {
    other: param.range(0, 1, { default: 0 }),
  },
  automatable: ['other'],
  graph: ({ input, params }) => logic.or(input, params.other),
});

export const logicXorMaterial = new AudioMaterial({
  name: 'LogicXor',
  kind: 'logicxor',
  params: {
    other: param.range(0, 1, { default: 0 }),
  },
  automatable: ['other'],
  graph: ({ input, params }) => logic.xor(input, params.other),
});

export const logicNotMaterial = new AudioMaterial({
  name: 'LogicNot',
  kind: 'logicnot',
  graph: ({ input }) => logic.not(input),
});

export const flipFlopMaterial = new AudioMaterial({
  name: 'FlipFlop',
  kind: 'flipflop',
  graph: ({ input }) => flipFlop(input),
});

export const quantizeMaterial = new AudioMaterial({
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

export const euclideanMaterial = new AudioMaterial({
  name: 'Euclidean',
  kind: 'euclidean',
  params: {
    clock: param.range(0, 1, { default: 0 }),
    steps: param.stepped(1, 32, { step: 1, default: 8 }),
    hits: param.stepped(0, 32, { step: 1, default: 3 }),
    rotation: param.stepped(0, 31, { step: 1, default: 0 }),
    reset: param.range(0, 1, { default: 0 }),
  },
  automatable: ['steps', 'hits', 'rotation'],
  channels: 1,
  cvPolarity: 'unipolar',
  graph: ({ params }) =>
    euclidean(params.clock, {
      steps: params.steps,
      hits: params.hits,
      rotation: params.rotation,
      // A synced clock is already on the grid, and the step counter under it
      // is not: it starts wherever it was left, so the pattern's first hit
      // lands on an arbitrary beat. This is what puts step zero on Play.
      reset: params.reset,
    }),
});

export const randomSteppedMaterial = new AudioMaterial({
  name: 'RandomStepped',
  kind: 'randomstepped',
  params: {
    freq: param.range(0.1, 40, { default: 8, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['freq'],
  graph: ({ params }) => random({ freq: params.freq, mode: 'stepped' }),
});

export const randomSmoothMaterial = new AudioMaterial({
  name: 'RandomSmooth',
  kind: 'randomsmooth',
  params: {
    freq: param.range(0.1, 40, { default: 4, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['freq'],
  graph: ({ params }) => random({ freq: params.freq, mode: 'smooth' }),
});

export const triggerMaterial = new AudioMaterial({
  name: 'Trigger',
  kind: 'trigger',
  params: {
    threshold: param.range(-1, 1, { default: 0.5 }),
  },
  automatable: ['threshold'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) => trigger(input, { threshold: params.threshold }),
});

export const pulseMaterial = new AudioMaterial({
  name: 'Pulse',
  kind: 'pulse',
  params: {
    widthSec: param.range(0.001, 2, { default: 0.01, unit: 's', curve: 'exp' }),
  },
  automatable: ['widthSec'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) => pulse(input, { widthSec: params.widthSec }),
});

export const sequencerMaterial = new AudioMaterial({
  name: 'Sequencer',
  kind: 'sequencer',
  params: {
    clock: param.range(0, 1, { default: 0 }),
    step0: param.range(-1, 1, { default: 0 }),
    step1: param.range(-1, 1, { default: 0.25 }),
    step2: param.range(-1, 1, { default: 0.5 }),
    step3: param.range(-1, 1, { default: 0.75 }),
    step4: param.range(-1, 1, { default: 1 }),
    step5: param.range(-1, 1, { default: 0.75 }),
    step6: param.range(-1, 1, { default: 0.5 }),
    step7: param.range(-1, 1, { default: 0.25 }),
    reset: param.range(0, 1, { default: 0 }),
  },
  automatable: ['step0', 'step1', 'step2', 'step3', 'step4', 'step5', 'step6', 'step7'],
  channels: 1,
  graph: ({ params }) =>
    sequencer(params.clock, [
      params.step0,
      params.step1,
      params.step2,
      params.step3,
      params.step4,
      params.step5,
      params.step6,
      params.step7,
    ], { reset: params.reset }),
});

/**
 * Note-driven envelope for cabling into another AudioMaterial's params.
 * Times are live (dahdsr under the hood). `gate` is a live inlet, so a
 * Keyboard gate cable is the same kind of signal a pulse sends into a
 * dahdsr. noteOn still opens it when nothing is patched into gate.
 */
export const adsrMaterial = new AudioMaterial({
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
  graph: ({ velocity, params, audio }) =>
    env
      .dahdsr({
        attack: params.attack,
        decay: params.decay,
        sustain: params.sustain,
        release: params.release,
        gate: audio.input('gate'),
      })
      .mul(velocity)
      .mul(params.amount),
});

export const dahdsrMaterial = new AudioMaterial({
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

export const offsetMaterial = new AudioMaterial({
  name: 'Offset',
  kind: 'offset',
  params: {
    amount: param.range(-2, 2, { default: 0 }),
  },
  automatable: ['amount'],
  graph: ({ input, params }) => input.add(params.amount),
});

export const controlMaterial = new AudioMaterial({
  name: 'Control',
  kind: 'control',
  params: {
    value: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['value'],
  graph: ({ params }) => params.value,
});

export const lfoMaterial = new AudioMaterial({
  name: 'LFO',
  kind: 'lfo',
  params: {
    type: param.enum(OSC_WAVE_NAMES, { default: 'Sine', label: 'Wave' }),
    width: param.range(0, 1, { default: 0.5, label: 'Shape' }),
    rate: param.range(0.05, 20, { default: 0.4, unit: 'Hz', curve: 'log' }),
    amount: param.range(0, 1, { default: 0.35 }),
    // Where in the cycle the shape is read, so two LFOs at one rate can sit
    // apart instead of on top of each other.
    phase: param.range(0, 1, { default: 0, label: 'Phase' }),
    // A jack, like the clocks. Patch the Transport's `playing` here and the
    // sweep starts with the song instead of wherever the plugin was loaded.
    reset: param.range(0, 1, { default: 0 }),
  },
  automatable: ['rate', 'amount', 'width', 'phase'],
  channels: 1,
  cvPolarity: 'bipolar',
  graph: ({ params }) =>
    lfo({
      rate: params.rate,
      shape: params.type,
      width: params.width,
      phase: params.phase,
      reset: params.reset,
    }).mul(params.amount),
});

export const breakpointEnvelopeMaterial = new AudioMaterial({
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
