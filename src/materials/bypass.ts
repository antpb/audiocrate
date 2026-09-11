import { AudioMaterial } from '../graph/AudioMaterial';

export const bypassMaterial = new AudioMaterial({
  name: 'Bypass',
  kind: 'bypass',
  graph: ({ input }) => input,
});
