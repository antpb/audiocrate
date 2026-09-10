import { denormalizeParam, type CvPolarity, type ParamDescriptor } from '../../src/index';

/** 0..1 for a unipolar source, (x+1)/2 for bipolar. */
export function modulatorUnit(sample: number, polarity: CvPolarity): number {
  const unit = polarity === 'unipolar' ? sample : (sample + 1) / 2;
  if (unit < 0) return 0;
  if (unit > 1) return 1;
  return unit;
}

/** Writes a modulator sample onto a param using that param's own curve. */
export function mapModulatorToParam(
  descriptor: ParamDescriptor,
  sample: number,
  polarity: CvPolarity,
): number {
  return denormalizeParam(descriptor, modulatorUnit(sample, polarity));
}
