import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { filter } from '../asl/builders';

export const lowpassMaterial = new Material({
  name: 'Lowpass',
  kind: 'lowpass',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' }),
    q: param.range(0.1, 10, { default: 0.707 }),
  },
  automatable: ['cutoff', 'q'],
  graph: ({ input, params }) => filter.lowpass(input, { cutoff: params.cutoff, q: params.q }),
});

export const highpassMaterial = new Material({
  name: 'Highpass',
  kind: 'highpass',
  params: {
    cutoff: param.range(20, 20000, { default: 200, unit: 'Hz', curve: 'log' }),
    q: param.range(0.1, 10, { default: 0.707 }),
  },
  automatable: ['cutoff', 'q'],
  graph: ({ input, params }) => filter.highpass(input, { cutoff: params.cutoff, q: params.q }),
});

export const bandpassMaterial = new Material({
  name: 'Bandpass',
  kind: 'bandpass',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' }),
    q: param.range(0.1, 20, { default: 1 }),
  },
  automatable: ['cutoff', 'q'],
  graph: ({ input, params }) => filter.bandpass(input, { cutoff: params.cutoff, q: params.q }),
});

export const notchMaterial = new Material({
  name: 'Notch',
  kind: 'notch',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' }),
    q: param.range(0.1, 20, { default: 1 }),
  },
  automatable: ['cutoff', 'q'],
  graph: ({ input, params }) => filter.notch(input, { cutoff: params.cutoff, q: params.q }),
});

export const lowShelfMaterial = new Material({
  name: 'LowShelf',
  kind: 'lowshelf',
  params: {
    freq: param.range(20, 20000, { default: 80, unit: 'Hz', curve: 'log' }),
    gainDb: param.range(-18, 18, { default: 0, unit: 'dB' }),
    q: param.range(0.1, 10, { default: 0.707 }),
  },
  automatable: ['freq', 'gainDb', 'q'],
  graph: ({ input, params }) =>
    filter.lowshelf(input, { freq: params.freq, gainDb: params.gainDb, q: params.q }),
});

export const highShelfMaterial = new Material({
  name: 'HighShelf',
  kind: 'highshelf',
  params: {
    freq: param.range(20, 20000, { default: 8000, unit: 'Hz', curve: 'log' }),
    gainDb: param.range(-18, 18, { default: 0, unit: 'dB' }),
    q: param.range(0.1, 10, { default: 0.707 }),
  },
  automatable: ['freq', 'gainDb', 'q'],
  graph: ({ input, params }) =>
    filter.highshelf(input, { freq: params.freq, gainDb: params.gainDb, q: params.q }),
});

export const allpassMaterial = new Material({
  name: 'Allpass',
  kind: 'allpass',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' }),
    q: param.range(0.1, 10, { default: 0.707 }),
  },
  automatable: ['cutoff', 'q'],
  graph: ({ input, params }) => filter.allpass(input, { cutoff: params.cutoff, q: params.q }),
});

export const onePoleLowpassMaterial = new Material({
  name: 'OnePoleLowpass',
  kind: 'onepolelowpass',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['cutoff'],
  graph: ({ input, params }) => filter.onePoleLowpass(input, { cutoff: params.cutoff }),
});

export const onePoleHighpassMaterial = new Material({
  name: 'OnePoleHighpass',
  kind: 'onepolehighpass',
  params: {
    cutoff: param.range(20, 20000, { default: 200, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['cutoff'],
  graph: ({ input, params }) => filter.onePoleHighpass(input, { cutoff: params.cutoff }),
});

export const svfLowpassMaterial = new Material({
  name: 'SVFLowpass',
  kind: 'svflowpass',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' }),
    q: param.range(0.1, 20, { default: 0.5 }),
  },
  automatable: ['cutoff', 'q'],
  graph: ({ input, params }) =>
    filter.svf(input, { cutoff: params.cutoff, q: params.q, mode: 'lowpass' }),
});

export const svfHighpassMaterial = new Material({
  name: 'SVFHighpass',
  kind: 'svfhighpass',
  params: {
    cutoff: param.range(20, 20000, { default: 200, unit: 'Hz', curve: 'log' }),
    q: param.range(0.1, 20, { default: 0.5 }),
  },
  automatable: ['cutoff', 'q'],
  graph: ({ input, params }) =>
    filter.svf(input, { cutoff: params.cutoff, q: params.q, mode: 'highpass' }),
});

export const svfBandpassMaterial = new Material({
  name: 'SVFBandpass',
  kind: 'svfbandpass',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' }),
    q: param.range(0.1, 20, { default: 0.5 }),
  },
  automatable: ['cutoff', 'q'],
  graph: ({ input, params }) =>
    filter.svf(input, { cutoff: params.cutoff, q: params.q, mode: 'bandpass' }),
});

export const ladderMaterial = new Material({
  name: 'Ladder',
  kind: 'ladder',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' }),
    resonance: param.range(0, 0.99, { default: 0 }),
  },
  automatable: ['cutoff', 'resonance'],
  graph: ({ input, params }) =>
    filter.ladder(input, { cutoff: params.cutoff, resonance: params.resonance }),
});

export const combMaterial = new Material({
  name: 'Comb',
  kind: 'comb',
  params: {
    freq: param.range(20, 4000, { default: 440, unit: 'Hz', curve: 'log' }),
    feedback: param.range(0, 0.95, { default: 0.5 }),
    mix: param.range(0, 1, { default: 0.5 }),
  },
  automatable: ['freq', 'feedback', 'mix'],
  graph: ({ input, params }) =>
    filter.comb(input, { freq: params.freq, feedback: params.feedback, mix: params.mix }),
});

export const slopeLowpass12Material = new Material({
  name: 'SlopeLowpass12',
  kind: 'slopelowpass12',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['cutoff'],
  graph: ({ input, params }) => filter.slope(input, { cutoff: params.cutoff, poles: 2, mode: 'lowpass' }),
});

export const slopeLowpass24Material = new Material({
  name: 'SlopeLowpass24',
  kind: 'slopelowpass24',
  params: {
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['cutoff'],
  graph: ({ input, params }) => filter.slope(input, { cutoff: params.cutoff, poles: 4, mode: 'lowpass' }),
});

export const slopeHighpass12Material = new Material({
  name: 'SlopeHighpass12',
  kind: 'slopehighpass12',
  params: {
    cutoff: param.range(20, 20000, { default: 200, unit: 'Hz', curve: 'log' }),
  },
  automatable: ['cutoff'],
  graph: ({ input, params }) => filter.slope(input, { cutoff: params.cutoff, poles: 2, mode: 'highpass' }),
});
