import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { bitcrush, downsample, rectify, select, waveshape } from '../asl/builders';
import type { ASLValue } from '../asl/ASLValue';

export const bitcrushMaterial = new Material({
  name: 'Bitcrush',
  kind: 'bitcrush',
  params: {
    bits: param.stepped(1, 16, { step: 1, default: 8 }),
  },
  automatable: ['bits'],
  graph: ({ input, params }) => bitcrush(input, { bits: params.bits }),
});

export const downsampleMaterial = new Material({
  name: 'Downsample',
  kind: 'downsample',
  params: {
    factor: param.stepped(1, 64, { step: 1, default: 4 }),
  },
  automatable: ['factor'],
  graph: ({ input, params }) => downsample(input, { factor: params.factor }),
});

export const fullRectifyMaterial = new Material({
  name: 'FullRectify',
  kind: 'fullrectify',
  graph: ({ input }) => rectify(input, { mode: 'full' }),
});

export const halfRectifyMaterial = new Material({
  name: 'HalfRectify',
  kind: 'halfrectify',
  graph: ({ input }) => rectify(input, { mode: 'half' }),
});

export const WAVESHAPE_CURVES = ['Soft', 'Hard', 'Fold', 'Asym', 'Sine'] as const;

const SOFT_CURVE = [-1, -0.92, -0.55, 0, 0.55, 0.92, 1];
const HARD_CURVE = [-1, -1, -0.15, 0, 0.15, 1, 1];
const FOLD_CURVE = [-1, 1, -1, 1, -1];
const ASYM_CURVE = [-1, -0.15, 0.05, 0.55, 1];
const SINE_CURVE = [-1, -0.92, -0.71, -0.38, 0, 0.38, 0.71, 0.92, 1];

function pickCurve(input: ASLValue, type: ASLValue): ASLValue {
  const soft = waveshape(input, { curve: SOFT_CURVE });
  const hard = waveshape(input, { curve: HARD_CURVE });
  const fold = waveshape(input, { curve: FOLD_CURVE });
  const asym = waveshape(input, { curve: ASYM_CURVE });
  const sine = waveshape(input, { curve: SINE_CURVE });
  return select(
    soft,
    select(
      hard,
      select(fold, select(asym, sine, { which: type.add(-3) }), { which: type.add(-2) }),
      { which: type.add(-1) },
    ),
    { which: type },
  );
}

/**
 * Transfer-curve shaper. Drive hits the curve harder, mix is dry/wet.
 * Soft and hard saturate, fold bounces, asym leans, sine is a sine shaper.
 */
export const waveshapeMaterial = new Material({
  name: 'Waveshape',
  kind: 'waveshape',
  params: {
    curve: param.enum(WAVESHAPE_CURVES, { default: 'Soft', label: 'Curve' }),
    drive: param.range(0.25, 12, { default: 1.6, curve: 'exp', label: 'Drive' }),
    mix: param.range(0, 1, { default: 1, label: 'Mix' }),
  },
  automatable: ['drive', 'mix'],
  graph: ({ input, params }) => {
    const driven = input.mul(params.drive);
    const wet = pickCurve(driven, params.curve);
    return input.mul(params.mix.mul(-1).add(1)).add(wet.mul(params.mix));
  },
});
