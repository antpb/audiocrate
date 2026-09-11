import { AudioMaterial, param, kernel, type AudioMaterialGraphContext, type RangeParamDescriptor } from './crate';
import { GRAIN_KERNEL_SLOT } from './kernelSlot';

/**
 * The AUv3 / VST3 grain param tree (79 entries). Addresses match
 * `homecrate_grainParameterAddresses.h`. Wet gates default to 0 so an
 * unloaded insert is passthrough. The graph is identity: the kernel in
 * grain_fx.wasm is the whole processor.
 */

export function createGrainMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'Grain',
    kind: 'grain',
    params: grainParams,
    automatable: Object.keys(grainParams),
    graph: grainGraph,
  });
}

export const grainParams: Record<string, RangeParamDescriptor> = {
  inputGain: param.range(0, 4, { default: 1, unit: 'lin', address: 0 }),
  outputGain: param.range(0, 4, { default: 1, unit: 'lin', address: 1 }),
  driveAmount: param.range(0, 1, { default: 0, address: 2 }),
  dryLevel: param.range(0, 1, { default: 1, address: 3 }),
  captureMode: param.range(0, 1, { default: 0, unit: 'index', address: 10 }),
  catchTrigger: param.range(0, 1, { default: 0, unit: 'bool', address: 11 }),
  freezeHold: param.range(0, 1, { default: 0, unit: 'bool', address: 12 }),
  loopLength: param.range(0.25, 5, { default: 2, unit: 's', address: 13 }),
  loopSync: param.range(0, 1, { default: 0, unit: 'bool', address: 14 }),
  loopDivision: param.range(0, 4, { default: 2, unit: 'index', address: 15 }),
  loopOverdub: param.range(0, 1, { default: 0, unit: 'bool', address: 16 }),
  loopFade: param.range(0, 1, { default: 0, unit: 'bool', address: 17 }),
  captureSource: param.range(0, 2, { default: 0, unit: 'index', address: 18 }),
  grainMix: param.range(0, 1, { default: 0, address: 30 }),
  grainSize: param.range(20, 500, { default: 120, unit: 'ms', address: 31 }),
  grainDensity: param.range(2, 80, { default: 18, unit: 'Hz', address: 32 }),
  grainSpray: param.range(0, 1, { default: 0.25, address: 33 }),
  grainPitch: param.range(-24, 24, { default: 0, unit: 'st', address: 34 }),
  grainPitchQuant: param.range(0, 1, { default: 0, unit: 'bool', address: 35 }),
  grainPitchRand: param.range(0, 1, { default: 0, address: 36 }),
  grainReverse: param.range(0, 1, { default: 0, address: 37 }),
  grainSpread: param.range(0, 1, { default: 0.6, address: 38 }),
  grainShape: param.range(0, 3, { default: 0, unit: 'index', address: 39 }),
  grainFeedback: param.range(0, 0.9, { default: 0, address: 40 }),
  grainScan: param.range(-2, 2, { default: 1, address: 41 }),
  grainClock: param.range(0, 3, { default: 0, unit: 'index', address: 42 }),
  crossTarget: param.range(0, 4, { default: 0, unit: 'index', address: 43 }),
  crossAmount: param.range(0, 1, { default: 0.5, address: 44 }),
  grainTone: param.range(0, 1, { default: 0.5, address: 45 }),
  midiMode: param.range(0, 2, { default: 0, unit: 'index', address: 46 }),
  midiRoot: param.range(0, 127, { default: 60, address: 47 }),
  midiAttack: param.range(1, 2000, { default: 5, unit: 'ms', address: 48 }),
  midiRelease: param.range(5, 5000, { default: 250, unit: 'ms', address: 49 }),
  delayTime: param.range(20, 2000, { default: 350, unit: 'ms', address: 50 }),
  delayFeedback: param.range(0, 1, { default: 0.35, address: 51 }),
  delayTone: param.range(0, 1, { default: 0.7, address: 52 }),
  delayLevel: param.range(0, 1, { default: 0, address: 53 }),
  delaySync: param.range(0, 1, { default: 0, unit: 'bool', address: 54 }),
  delayDivision: param.range(0, 6, { default: 1, unit: 'index', address: 55 }),
  delayPingPong: param.range(0, 1, { default: 0, unit: 'bool', address: 56 }),
  delayTape: param.range(0, 1, { default: 0, unit: 'bool', address: 57 }),
  delayDuck: param.range(0, 1, { default: 0, unit: 'bool', address: 58 }),
  delaySend: param.range(0, 2, { default: 0, unit: 'index', address: 59 }),
  delayRoute: param.range(0, 3, { default: 0, unit: 'index', address: 60 }),
  delayOscillate: param.range(0, 1, { default: 0, unit: 'bool', address: 61 }),
  reverbDecay: param.range(0, 1, { default: 0.5, address: 70 }),
  reverbBlend: param.range(0, 1, { default: 0, address: 71 }),
  reverbSize: param.range(0.5, 2, { default: 1, address: 72 }),
  reverbPreDelay: param.range(0, 100, { default: 10, unit: 'ms', address: 73 }),
  reverbTone: param.range(0, 1, { default: 0.7, address: 74 }),
  reverbDryFeed: param.range(0, 1, { default: 0, address: 75 }),
  washAmount: param.range(0, 1, { default: 0, address: 80 }),
  washWarble: param.range(0, 1, { default: 0, address: 81 }),
  washMode: param.range(0, 2, { default: 0, unit: 'index', address: 82 }),
  glueAmount: param.range(0, 1, { default: 0, address: 83 }),
  catchCC: param.range(0, 127, { default: 24, address: 90 }),
  freezeCC: param.range(0, 127, { default: 25, address: 91 }),
  oscillateCC: param.range(0, 127, { default: 27, address: 92 }),
  resMix: param.range(0, 1, { default: 0, address: 100 }),
  resQ: param.range(0, 1, { default: 0.5, address: 101 }),
  resRotate: param.range(0, 1, { default: 0, address: 102 }),
  resSpread: param.range(0, 1, { default: 0, address: 103 }),
  keyMask: param.range(1, 4095, { default: 2741, address: 104 }),
  resRoot: param.range(24, 72, { default: 40, address: 105 }),
  resMorph: param.range(0, 1, { default: 0.3, address: 106 }),
  resBandMask: param.range(1, 63, { default: 63, address: 107 }),
  resSend: param.range(0, 2, { default: 2, unit: 'index', address: 108 }),
  resLfoTarget: param.range(0, 6, { default: 0, unit: 'index', address: 110 }),
  resLfoRate: param.range(0.05, 8, { default: 1, unit: 'Hz', address: 111 }),
  resLfoSync: param.range(0, 1, { default: 0, unit: 'bool', address: 112 }),
  resLfoDivision: param.range(0, 6, { default: 1, unit: 'index', address: 113 }),
  resLfoShape: param.range(0, 5, { default: 0, unit: 'index', address: 114 }),
  resLfoDepth: param.range(0, 1, { default: 0, address: 115 }),
  grainLfoTarget: param.range(0, 7, { default: 0, unit: 'index', address: 120 }),
  grainLfoRate: param.range(0.05, 8, { default: 1, unit: 'Hz', address: 121 }),
  grainLfoSync: param.range(0, 1, { default: 0, unit: 'bool', address: 122 }),
  grainLfoDivision: param.range(0, 6, { default: 1, unit: 'index', address: 123 }),
  grainLfoShape: param.range(0, 5, { default: 0, unit: 'index', address: 124 }),
  grainLfoDepth: param.range(0, 1, { default: 0, address: 125 }),
};

/** Source kernel. `passthrough` fallback so an unloaded insert stays open. */
function grainGraph({ input }: AudioMaterialGraphContext) {
  return kernel.source(GRAIN_KERNEL_SLOT, input, { fallback: 'passthrough' });
}

export const grainMaterial = createGrainMaterial();
