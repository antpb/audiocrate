import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { envFollow } from '../asl/builders';

/** Analysis insert: replaces the signal with its amplitude envelope. */
export const envelopeFollowerMaterial = new Material({
  name: 'EnvelopeFollower',
  kind: 'envfollow',
  params: {
    attack: param.range(0.001, 1, { default: 0.01, unit: 's', curve: 'exp' }),
    release: param.range(0.001, 2, { default: 0.1, unit: 's', curve: 'exp' }),
  },
  automatable: ['attack', 'release'],
  cvPolarity: 'unipolar',
  graph: ({ input, params }) => envFollow(input, { attack: params.attack, release: params.release }),
});
