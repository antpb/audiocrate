import { AudioMaterial } from '../graph/AudioMaterial';
import { dcBlock } from '../asl/builders';

export const dcBlockerMaterial = new AudioMaterial({
  name: 'DCBlocker',
  kind: 'dcblock',
  graph: ({ input }) => dcBlock(input),
});
