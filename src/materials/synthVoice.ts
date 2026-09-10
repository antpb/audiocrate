import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { env, filter, osc, uniform } from '../asl/builders';
import { OSC_WAVE_NAMES } from './sources';

/**
 * A playable subtractive voice: wave, unison, filter with envelope amount,
 * and a live amp ADSR. The full AUv3 synth stays on the `synth` kernel.
 */
export const synthVoiceMaterial = new Material({
  name: 'SynthVoice',
  kind: 'SynthVoice',
  params: {
    type: param.enum(OSC_WAVE_NAMES, { default: 'Saw', label: 'Wave' }),
    width: param.range(0, 1, { default: 0.5, label: 'Shape' }),
    octave: param.stepped(-2, 2, { default: 0, step: 1, label: 'Octave' }),
    detune: param.range(-100, 100, { default: 0, unit: 'ct', label: 'Detune' }),
    unison: param.range(0, 1, { default: 0.22, label: 'Unison' }),
    cutoff: param.range(80, 12000, { default: 2000, unit: 'Hz', curve: 'log' }),
    resonance: param.range(0.3, 8, { default: 0.8 }),
    envAmt: param.range(-1, 2, { default: 0.35, label: 'Env Amt' }),
    attack: param.range(0.001, 2, { default: 0.005, unit: 's', curve: 'exp' }),
    decay: param.range(0.001, 2, { default: 0.12, unit: 's', curve: 'exp' }),
    sustain: param.range(0, 1, { default: 0.6 }),
    release: param.range(0.001, 4, { default: 0.35, unit: 's', curve: 'exp' }),
    gain: param.range(0, 1, { default: 0.7 }),
  },
  automatable: ['cutoff', 'resonance', 'envAmt', 'gain', 'unison', 'width', 'attack', 'release'],
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
    const oscA = osc({ freq, type: params.type, width: params.width });
    const oscB = osc({ freq: freq.mul(1.008), type: params.type, width: params.width });
    const carrier = oscA.add(oscB.mul(params.unison));
    const cutoff = params.cutoff.mul(amp.mul(params.envAmt).add(1));
    return filter.lowpass(carrier, { cutoff, q: params.resonance }).mul(amp).mul(params.gain);
  },
});
