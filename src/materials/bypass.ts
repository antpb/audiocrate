import { Material } from '../graph/Material';

export const bypassMaterial = new Material({
  name: 'Bypass',
  kind: 'bypass',
  graph: ({ input }) => input,
});
