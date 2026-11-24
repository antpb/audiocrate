import { param, type RangeParamDescriptor } from './crate';

/**
 * hc_dynEQ's parameter tree, addresses as homecrate_dyneqParameterAddresses.h
 * (never renumbered: saved projects address them). Defaults and ranges as the
 * AU's, so an empty slot is the AU at its defaults: a clean EQ and an idle
 * compressor.
 */
export const dyneqParams: Record<string, RangeParamDescriptor> = {
  inputGain: param.range(0, 4, { default: 1, address: 0, label: 'In' }),
  outputGain: param.range(0, 4, { default: 1, address: 1, label: 'Out' }),
  eqBand0: param.range(-12, 12, { default: 0, unit: 'dB', address: 10, label: '100' }),
  eqBand1: param.range(-12, 12, { default: 0, unit: 'dB', address: 11, label: '300' }),
  eqBand2: param.range(-12, 12, { default: 0, unit: 'dB', address: 12, label: '1K2' }),
  eqBand3: param.range(-12, 12, { default: 0, unit: 'dB', address: 13, label: '3K5' }),
  eqBand4: param.range(-12, 12, { default: 0, unit: 'dB', address: 14, label: '10K' }),
  duckDepth0: param.range(-24, 12, { default: 0, unit: 'dB', address: 20, label: 'Duck 100' }),
  duckDepth1: param.range(-24, 12, { default: 0, unit: 'dB', address: 21, label: 'Duck 300' }),
  duckDepth2: param.range(-24, 12, { default: 0, unit: 'dB', address: 22, label: 'Duck 1K2' }),
  duckDepth3: param.range(-24, 12, { default: 0, unit: 'dB', address: 23, label: 'Duck 3K5' }),
  duckDepth4: param.range(-24, 12, { default: 0, unit: 'dB', address: 24, label: 'Duck 10K' }),
  duckAttack: param.range(1, 200, { default: 5, unit: 'ms', address: 30, label: 'Follower attack' }),
  duckRelease: param.range(10, 1000, { default: 120, unit: 'ms', address: 31, label: 'Follower release' }),
  compThresh: param.range(-60, 0, { default: 0, unit: 'dB', address: 40, label: 'Thresh' }),
  compRatio: param.range(1, 20, { default: 4, address: 41, label: 'Ratio' }),
  compAttack: param.range(0.1, 100, { default: 5, unit: 'ms', address: 42, label: 'Attack' }),
  compRelease: param.range(10, 1000, { default: 120, unit: 'ms', address: 43, label: 'Release' }),
  compMakeup: param.range(0, 24, { default: 0, unit: 'dB', address: 44, label: 'Makeup' }),
  compKey: param.range(0, 1, { default: 0, unit: 'index', address: 45, label: 'Key' }),
  compPlacement: param.range(0, 1, { default: 1, unit: 'index', address: 46, label: 'Position' }),
};

/** hc_send: one knob. (busIndex and envMode are reserved in v1 and unused.) */
export const sendParams: Record<string, RangeParamDescriptor> = {
  sendLevel: param.range(0, 2, { default: 1, address: 100, label: 'Send' }),
};
