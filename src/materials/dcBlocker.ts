import { Material } from '../graph/Material';
import { dcBlock } from '../asl/builders';

export const dcBlockerMaterial = new Material({
  name: 'DCBlocker',
  kind: 'dcblock',
  graph: ({ input }) => dcBlock(input),
});
