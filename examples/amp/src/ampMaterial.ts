import { AudioMaterial, param, filter, kernel, type AudioMaterialGraphContext, type RangeParamDescriptor } from './crate';
import type { ASLValue, ASLValueLike } from '../../../src/asl/ASLValue';
import { AMP_KERNEL_SLOT } from './kernelSlot';

/**
 * Fixed tone-stack frequencies from the amp kernel's recomputeEQCoeffs:
 * low shelf, three peaks, high shelf, all Q = 0.707.
 */
export const AMP_EQ_FREQS = [80, 250, 800, 3200, 8000] as const;

/**
 * The AUv3 / shared-plugin param tree (46 entries). Addresses match
 * `homecrate_ampParameterAddresses.h`. VST3 adds a 47th (`inputCalibration`,
 * address 47) that is not on the AUv3 and is not declared here.
 *
 * Reverb, delay, and IR run in the WASM amp-fx module around `neural.nam`.
 * Morph / stereo / reverbGate stay declared and inert.
 */

export function createAmpMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'Amp',
    kind: 'amp',
    params: ampParams,
    automatable: Object.keys(ampParams),
    graph: ampGraph,
  });
}
export const ampParams: Record<string, RangeParamDescriptor> = {
  inputGain: param.range(0, 4, { default: 1, unit: 'lin', address: 0 }),
  outputGain: param.range(0, 4, { default: 1, unit: 'lin', address: 1 }),
  irNormalize: param.range(0, 1, { default: 1, unit: 'bool', address: 12 }),
  eqBand0: param.range(-12, 12, { default: 0, unit: 'dB', address: 3 }),
  eqBand1: param.range(-12, 12, { default: 0, unit: 'dB', address: 4 }),
  eqBand2: param.range(-12, 12, { default: 0, unit: 'dB', address: 5 }),
  eqBand3: param.range(-12, 12, { default: 0, unit: 'dB', address: 6 }),
  eqBand4: param.range(-12, 12, { default: 0, unit: 'dB', address: 7 }),
  reverbDecay: param.range(0, 1, { default: 0.5, address: 8 }),
  reverbSize: param.range(0.5, 2, { default: 1, address: 10 }),
  reverbPreDelay: param.range(0, 100, { default: 0, unit: 'ms', address: 11 }),
  reverbBlend: param.range(0, 1, { default: 0, address: 9 }),
  reverbTone: param.range(0, 1, { default: 0.7, address: 13 }),
  reverbPreAmp: param.range(0, 1, { default: 0, unit: 'bool', address: 14 }),
  eqPostAmp: param.range(0, 1, { default: 0, unit: 'bool', address: 15 }),
  reverbGate: param.range(0, 1, { default: 0, unit: 'bool', address: 16 }),
  stereoMode: param.range(0, 1, { default: 0, unit: 'bool', address: 17 }),
  inputPad: param.range(0, 1, { default: 0, unit: 'bool', address: 18 }),
  invertR: param.range(0, 1, { default: 0, unit: 'bool', address: 19 }),
  channelLink: param.range(0, 1, { default: 1, unit: 'bool', address: 20 }),
  volLink: param.range(0, 1, { default: 1, unit: 'bool', address: 23 }),
  inputGainR: param.range(0, 4, { default: 1, unit: 'lin', address: 21 }),
  outputGainR: param.range(0, 4, { default: 1, unit: 'lin', address: 22 }),
  delayTime: param.range(20, 2000, { default: 350, unit: 'ms', address: 24 }),
  delayFeedback: param.range(0, 1, { default: 0.35, address: 25 }),
  delayTone: param.range(0, 1, { default: 0.7, address: 26 }),
  delayMix: param.range(0, 1, { default: 0, address: 27 }),
  delaySync: param.range(0, 1, { default: 0, unit: 'bool', address: 28 }),
  delayDivision: param.range(0, 6, { default: 1, unit: 'index', address: 29 }),
  delayPingPong: param.range(0, 1, { default: 0, unit: 'bool', address: 30 }),
  delayTape: param.range(0, 1, { default: 0, unit: 'bool', address: 31 }),
  delayDuck: param.range(0, 1, { default: 0, unit: 'bool', address: 32 }),
  delayPlacement: param.range(0, 2, { default: 2, unit: 'index', address: 33 }),
  delayOscillate: param.range(0, 1, { default: 0, unit: 'bool', address: 34 }),
  delayOscCC: param.range(0, 127, { default: 27, address: 35 }),
  morphEnable: param.range(0, 1, { default: 0, unit: 'bool', address: 36 }),
  morphSource: param.range(0, 1, { default: 0, unit: 'index', address: 37 }),
  morphDepth: param.range(0, 1, { default: 0.75, address: 38 }),
  morphThreshold: param.range(0, 1, { default: 0.35, address: 39 }),
  morphSensitivity: param.range(0, 1, { default: 0.5, address: 40 }),
  morphAttack: param.range(1, 200, { default: 5, unit: 'ms', address: 41 }),
  morphRelease: param.range(10, 1000, { default: 120, unit: 'ms', address: 42 }),
  morphInvert: param.range(0, 1, { default: 0, unit: 'bool', address: 43 }),
  morphManual: param.range(0, 1, { default: 0, address: 44 }),
  morphTargetAmp: param.range(0, 1, { default: 1, unit: 'bool', address: 45 }),
  morphTargetIR: param.range(0, 1, { default: 1, unit: 'bool', address: 46 }),
};

const EQ_Q = 0.707;

/**
 * The tone stack cascade. Exported so `playback/bakeAmp.ts` can run it as its
 * own standalone pass for `eqPostAmp` (see `buildAmpEqOnlyGraph` below): a
 * biquad chain placed *downstream* of `neural.nam` inside one interpreted
 * graph gets double-stepped by `compile.ts`'s block collect/apply phases
 * (collect walks the whole `graph.output` tree once per sample with `nam`'s
 * own output stubbed to 0, which still runs any stateful node reachable from
 * it); avoided entirely by never putting a stateful node after `neural.nam`
 * in the *live* graph, and instead running the post-EQ pass as its own
 * separate, nam-free `OfflineRenderer.render` call at bake time.
 */
export function toneStack(signal: ASLValueLike, params: AudioMaterialGraphContext['params']): ASLValue {
  const eq0 = filter.lowshelf(signal, { freq: AMP_EQ_FREQS[0], gainDb: params.eqBand0, q: EQ_Q });
  const eq1 = filter.peaking(eq0, { freq: AMP_EQ_FREQS[1], gainDb: params.eqBand1, q: EQ_Q });
  const eq2 = filter.peaking(eq1, { freq: AMP_EQ_FREQS[2], gainDb: params.eqBand2, q: EQ_Q });
  const eq3 = filter.peaking(eq2, { freq: AMP_EQ_FREQS[3], gainDb: params.eqBand3, q: EQ_Q });
  return filter.highshelf(eq3, { freq: AMP_EQ_FREQS[4], gainDb: params.eqBand4, q: EQ_Q });
}

/** `params.inputPad` on (-20 dB) times `params.inputGain`, matching the kernel's `stageInput`. */
function gainStage(input: ASLValue, params: AudioMaterialGraphContext['params']): ASLValue {
  const padScale = params.inputPad.mul(-0.9).add(1);
  return input.mul(padScale).mul(params.inputGain);
}

/**
 * The live, bindable graph: EQ pre-amp (the shipping default), one
 * `neural.nam` call, output gain. `eqPostAmp` is handled entirely at bake
 * time (`playback/bakeAmp.ts`), not here, see `toneStack`'s doc comment.
 */
function ampGraph({ input, params }: AudioMaterialGraphContext) {
  const gained = gainStage(input, params);
  const preEQ = toneStack(gained, params);
  return kernel.seam(AMP_KERNEL_SLOT, preEQ).mul(params.outputGain);
}

/**
 * The bake-time NAM stage, pre-outputGain and pre-post-EQ: `eqPostAmp` false
 * (the default) EQs before NAM, exactly matching `ampGraph`/`.graph` above so
 * results agree in the common case; `eqPostAmp` true feeds NAM the raw
 * gained signal, matching the kernel's own "which EQ position" choice, since
 * that changes NAM's actual input spectrum, not just where filtering happens
 * afterward.
 */
export function buildAmpNamGraph(eqPostAmp: boolean) {
  return new AudioMaterial({
    name: 'AmpNamStage',
    params: ampParams,
    graph: ({ input, params }) => {
      const gained = gainStage(input, params);
      const namInput = eqPostAmp ? gained : toneStack(gained, params);
      return kernel.seam(AMP_KERNEL_SLOT, namInput);
    },
  }).graph;
}

/**
 * The bake-time post-amp EQ pass: no `neural.nam` node at all, so it runs
 * through the interpreter's plain per-sample path with none of the
 * block/collect-phase behavior `neural.nam` triggers. Only used when
 * `eqPostAmp` is true, applied to the NAM stage's output (which already
 * includes ampFx's IR/reverb/delay wrap), matching the kernel's actual
 * post-amp EQ position: after the cab, not immediately after NAM.
 */
export function buildAmpEqOnlyGraph() {
  return new AudioMaterial({
    name: 'AmpEqStage',
    params: ampParams,
    graph: ({ input, params }) => toneStack(input, params),
  }).graph;
}

export const ampMaterial = createAmpMaterial();
