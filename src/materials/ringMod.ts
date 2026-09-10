import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { osc } from '../asl/builders';

/** Named multiply against a sine. The node is `mul`; the name is how people patch it. */
export const ringModMaterial = new Material({
  name: 'RingMod',
  kind: 'ringmod',
  params: {
    freq: param.range(1, 4000, { default: 220, unit: 'Hz', curve: 'log' }),
    mix: param.range(0, 1, { default: 1 }),
  },
  automatable: ['freq', 'mix'],
  graph: ({ input, params }) => {
    const wet = input.mul(osc({ freq: params.freq, type: 'sine' }));
    const dry = input.mul(params.mix.mul(-1).add(1));
    return wet.mul(params.mix).add(dry);
  },
});
