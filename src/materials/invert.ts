import { AudioMaterial } from '../graph/AudioMaterial';

/** Polarity flip. No params: the implementation is unique. */
export const invertMaterial = new AudioMaterial({
  name: 'Invert',
  kind: 'invert',
  graph: ({ input }) => input.mul(-1),
});
