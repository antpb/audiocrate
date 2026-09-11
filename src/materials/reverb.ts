import { AudioMaterial } from '../graph/AudioMaterial';
import { param } from '../graph/param';
import { delay, filter, mix, uniform } from '../asl/builders';

const COMB_TIMES = [0.0253, 0.0269, 0.029, 0.0307, 0.0338, 0.0367] as const;

export const reverbMaterial = new AudioMaterial({
  name: 'Reverb',
  kind: 'reverb',
  params: {
    size: param.range(0.3, 1.4, { default: 0.85 }),
    decay: param.range(0, 0.92, { default: 0.72 }),
    damp: param.range(200, 12000, { default: 4500, unit: 'Hz', curve: 'log' }),
    mix: param.range(0, 1, { default: 0.28 }),
  },
  automatable: ['size', 'decay', 'damp', 'mix'],
  graph: ({ input, params }) => {
    const combs = COMB_TIMES.map((time) =>
      delay(input, {
        timeSec: params.size.mul(time),
        feedback: params.decay,
        mix: 1,
        maxTimeSec: 0.25,
      }),
    );
    const tank = mix(...combs).mul(1 / COMB_TIMES.length);
    const diffused = delay(
      delay(tank, {
        timeSec: params.size.mul(0.005),
        feedback: 0.5,
        mix: 1,
        maxTimeSec: 0.08,
      }),
      {
        timeSec: params.size.mul(0.017),
        feedback: 0.5,
        mix: 1,
        maxTimeSec: 0.08,
      },
    );
    const wet = filter.onePoleLowpass(diffused, { cutoff: params.damp }).mul(params.mix);
    const dry = input.mul(uniform(1).add(params.mix.mul(-1)));
    return mix(dry, wet);
  },
});
