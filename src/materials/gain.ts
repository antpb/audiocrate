import { AudioMaterial } from '../graph/AudioMaterial';
import { param } from '../graph/param';

/** VCA. Linear gain, default unity. */
export const gainMaterial = new AudioMaterial({
  name: 'Gain',
  kind: 'gain',
  params: {
    gain: param.range(0, 4, { default: 1 }),
  },
  automatable: ['gain'],
  graph: ({ input, params }) => input.mul(params.gain),
});
