import { AudioMaterial } from '../graph/AudioMaterial';
import { param } from '../graph/param';
import { delay } from '../asl/builders';

export const delayMaterial = new AudioMaterial({
  name: 'Delay',
  kind: 'delay',
  params: {
    timeSec: param.range(0, 2, { default: 0.25, unit: 's', curve: 'exp' }),
    feedback: param.range(0, 0.95, { default: 0.3 }),
    mix: param.range(0, 1, { default: 0.35 }),
  },
  automatable: ['timeSec', 'feedback', 'mix'],
  graph: ({ input, params }) =>
    delay(input, { timeSec: params.timeSec, feedback: params.feedback, mix: params.mix, maxTimeSec: 2 }),
});
