import { AudioMaterial } from '../graph/AudioMaterial';
import { param } from '../graph/param';
import { mix, panLaw, select } from '../asl/builders';

export const selectMaterial = new AudioMaterial({
  name: 'Select',
  kind: 'select',
  params: {
    other: param.range(-1, 1, { default: 0 }),
    which: param.toggle({ default: false, labels: ['Input', 'Other'] }),
  },
  automatable: ['other', 'which'],
  graph: ({ input, params }) => select(input, params.other, { which: params.which }),
});

export const panLeftMaterial = new AudioMaterial({
  name: 'PanLeft',
  kind: 'panleft',
  params: {
    pan: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['pan'],
  graph: ({ input, params }) => panLaw(input, { pan: params.pan, channel: 'left' }),
});

export const panRightMaterial = new AudioMaterial({
  name: 'PanRight',
  kind: 'panright',
  params: {
    pan: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['pan'],
  graph: ({ input, params }) => panLaw(input, { pan: params.pan, channel: 'right' }),
});

export const mixMaterial = new AudioMaterial({
  name: 'Mix',
  kind: 'mix',
  params: {
    a: param.range(-1, 1, { default: 0 }),
    b: param.range(-1, 1, { default: 0 }),
    c: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['a', 'b', 'c'],
  graph: ({ input, params }) => mix(input, params.a, params.b, params.c),
});
