import { AudioMaterial } from '../graph/AudioMaterial';
import { param } from '../graph/param';
import { compare, compressor, envFollow, expander, logic, pulse, transient } from '../asl/builders';

export const compressorMaterial = new AudioMaterial({
  name: 'Compressor',
  kind: 'compressor',
  params: {
    threshold: param.range(0.01, 1, { default: 0.5 }),
    ratio: param.range(1, 20, { default: 4 }),
    attack: param.range(0.001, 0.2, { default: 0.005, unit: 's', curve: 'exp' }),
    release: param.range(0.01, 1, { default: 0.05, unit: 's', curve: 'exp' }),
    makeup: param.range(0, 4, { default: 1, label: 'Makeup' }),
    mix: param.range(0, 1, { default: 1 }),
  },
  automatable: ['threshold', 'ratio', 'attack', 'release', 'makeup', 'mix'],
  graph: ({ input, params }) => {
    const wet = compressor(input, {
      threshold: params.threshold,
      ratio: params.ratio,
      attack: params.attack,
      release: params.release,
    }).mul(params.makeup);
    return input.mul(params.mix.mul(-1).add(1)).add(wet.mul(params.mix));
  },
});

export const limiterMaterial = new AudioMaterial({
  name: 'Limiter',
  kind: 'limiter',
  params: {
    threshold: param.range(0.01, 1, { default: 0.89 }),
    attack: param.range(0.0005, 0.05, { default: 0.001, unit: 's', curve: 'exp' }),
    release: param.range(0.01, 1, { default: 0.05, unit: 's', curve: 'exp' }),
  },
  automatable: ['threshold', 'attack', 'release'],
  graph: ({ input, params }) =>
    compressor(input, {
      threshold: params.threshold,
      ratio: 20,
      attack: params.attack,
      release: params.release,
    }),
});

export const gateMaterial = new AudioMaterial({
  name: 'Gate',
  kind: 'gate',
  params: {
    threshold: param.range(0.001, 1, { default: 0.05 }),
    attack: param.range(0.001, 0.2, { default: 0.002, unit: 's', curve: 'exp' }),
    release: param.range(0.01, 1, { default: 0.05, unit: 's', curve: 'exp' }),
    // The shortest time the gate may stay open once it has opened. Without
    // one, material that decays across the threshold chatters: the gate
    // closes, the tail is still ringing, it opens again, and the result is a
    // buzz rather than silence. A pulse holds it open, so the whole thing is
    // ASL rather than a second envelope in the kernel.
    hold: param.range(0, 0.5, { default: 0, unit: 's' }),
  },
  automatable: ['threshold', 'attack', 'release', 'hold'],
  graph: ({ input, params }) => {
    const envelope = envFollow(input, { attack: params.attack, release: params.release });
    const open = compare(envelope, { threshold: params.threshold, mode: 'gt' });
    // At hold 0 the pulse is one sample wide and lands on the sample `open`
    // already went high, so the or is exactly `open` and a gate that exists
    // keeps sounding like itself.
    return input.mul(logic.or(open, pulse(open, { widthSec: params.hold })));
  },
});

export const expanderMaterial = new AudioMaterial({
  name: 'Expander',
  kind: 'expander',
  params: {
    threshold: param.range(0.01, 1, { default: 0.25 }),
    ratio: param.range(1, 20, { default: 2 }),
    attack: param.range(0.001, 0.2, { default: 0.005, unit: 's', curve: 'exp' }),
    release: param.range(0.01, 1, { default: 0.05, unit: 's', curve: 'exp' }),
  },
  automatable: ['threshold', 'ratio', 'attack', 'release'],
  graph: ({ input, params }) =>
    expander(input, {
      threshold: params.threshold,
      ratio: params.ratio,
      attack: params.attack,
      release: params.release,
    }),
});

export const transientMaterial = new AudioMaterial({
  name: 'Transient',
  kind: 'transient',
  params: {
    attack: param.range(-1, 1, { default: 0 }),
    sustain: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['attack', 'sustain'],
  graph: ({ input, params }) => transient(input, { attack: params.attack, sustain: params.sustain }),
});
