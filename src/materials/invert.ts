import { Material } from '../graph/Material';

/** Polarity flip. No params: the implementation is unique. */
export const invertMaterial = new Material({
  name: 'Invert',
  kind: 'invert',
  graph: ({ input }) => input.mul(-1),
});
