import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { onset, peak, rms } from '../asl/builders';

export const rmsMaterial = new Material({
  name: 'RMS',
  kind: 'rms',
  params: {
    windowSec: param.range(0.005, 0.5, { default: 0.05, unit: 's', curve: 'exp' }),
  },
  automatable: ['windowSec'],
  graph: ({ input, params }) => rms(input, { windowSec: params.windowSec }),
});

export const peakMaterial = new Material({
  name: 'Peak',
  kind: 'peak',
  params: {
    release: param.range(0.01, 2, { default: 0.3, unit: 's', curve: 'exp' }),
  },
  automatable: ['release'],
  graph: ({ input, params }) => peak(input, { release: params.release }),
});

export const onsetMaterial = new Material({
  name: 'Onset',
  kind: 'onset',
  params: {
    threshold: param.range(0.001, 0.5, { default: 0.05 }),
  },
  automatable: ['threshold'],
  graph: ({ input, params }) => onset(input, { threshold: params.threshold }),
});
