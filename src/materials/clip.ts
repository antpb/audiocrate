import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { clip } from '../asl/builders';

export const softClipMaterial = new Material({
  name: 'SoftClip',
  kind: 'softclip',
  params: {
    drive: param.range(0.1, 16, { default: 1 }),
  },
  automatable: ['drive'],
  graph: ({ input, params }) => clip(input, { drive: params.drive, mode: 'soft' }),
});

export const hardClipMaterial = new Material({
  name: 'HardClip',
  kind: 'hardclip',
  params: {
    drive: param.range(0.1, 16, { default: 1 }),
  },
  automatable: ['drive'],
  graph: ({ input, params }) => clip(input, { drive: params.drive, mode: 'hard' }),
});
