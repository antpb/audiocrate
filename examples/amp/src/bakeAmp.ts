import { OfflineRenderer, type AudioMaterial } from './crate';
import { ampKernelFactory, type AmpKernelPayload } from './kernel';
import { AMP_KERNEL_SLOT } from './kernelSlot';
import { buildAmpNamGraph, buildAmpEqOnlyGraph } from './ampMaterial';
import { ampNamAsset, ampNamAssetR, type NamAssetData } from './assets';

export interface BakeAmpOptions {
  /** Compiled `nam.wasm` bytes. Omit to run without real NAM inference (EQ/pad/gain still apply). */
  namWasmBinary?: ArrayBuffer | Uint8Array;
  /** Compiled `amp_fx.wasm` bytes. Omit to skip Costello reverb / delay (and reverbGate, which lives inside amp_fx.wasm). */
  ampFxWasmBinary?: ArrayBuffer | Uint8Array;
}

type ProfileSlot = 'primary' | 'secondary';

function namFor(material: AudioMaterial, slot: ProfileSlot): NamAssetData | undefined {
  return slot === 'primary' ? ampNamAsset(material) : ampNamAssetR(material);
}

interface ChannelOverrides {
  nam?: ProfileSlot;
  inputGain?: number;
  outputGain?: number;
}

/**
 * One channel's full amp chain: gain/pad -> (pre-EQ or raw) -> NAM ->
 * ampFx (reverb/delay, including the gate) -> (post-EQ) -> output gain.
 * Matches the kernel's `stageInput`/`stageAmp`/`stageOutput` for one
 * channel. `overrides` lets a caller pick the companion NAM profile
 * and/or independent gain (stereo companion, morph's chain B). Cabinet
 * convolution is the IR AudioMaterial, not this chain.
 */
async function renderAmpChannel(
  material: AudioMaterial,
  input: Float32Array,
  sampleRate: number,
  options: BakeAmpOptions,
  overrides: ChannelOverrides = {},
): Promise<Float32Array> {
  const eqPostAmp = material.getParam('eqPostAmp') >= 0.5;
  const namAsset = namFor(material, overrides.nam ?? 'primary');

  // The same kernel the live worklet loads, built on the main thread. An
  // offline bake has no worklet to load one into, so the plugin drives its
  // own engines here; going through the factory keeps one code path.
  const kernelProcessor = await ampKernelFactory(sampleRate, {
    ampFxWasm: options.ampFxWasmBinary,
    namWasm: options.namWasmBinary,
    namJson: namAsset?.json,
  } satisfies AmpKernelPayload);
  const kernels = { [AMP_KERNEL_SLOT]: kernelProcessor };

  try {
    const params: Record<string, number> = { ...material.snapshotParams() };
    if (overrides.inputGain !== undefined) params.inputGain = overrides.inputGain;
    if (overrides.outputGain !== undefined) params.outputGain = overrides.outputGain;

    const namGraph = buildAmpNamGraph(eqPostAmp);
    const namResult = OfflineRenderer.render(namGraph, {
      duration: input.length / sampleRate,
      sampleRate,
      inputSignal: input,
      params,
      kernels,
    });

    let stage = namResult.samples;
    if (eqPostAmp) {
      const eqGraph = buildAmpEqOnlyGraph();
      stage = OfflineRenderer.render(eqGraph, {
        duration: stage.length / sampleRate,
        sampleRate,
        inputSignal: stage,
        params,
      }).samples;
    }

    const outputGain = params.outputGain ?? 1;
    const out = new Float32Array(stage.length);
    for (let i = 0; i < out.length; i++) out[i] = stage[i]! * outputGain;
    return out;
  } finally {
    kernelProcessor.dispose?.();
  }
}

function onePoleMs(ms: number, sampleRate: number): number {
  const t = Math.max(ms, 0.01) * 0.001;
  return 1 - Math.exp(-1 / (t * sampleRate));
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * The pad+inputGain-only signal `computeMorphTarget` reads in the native
 * kernel (`mMonoBuf` at that call site). Approximation, disclosed: native's
 * detector actually runs on the signal *after* pre-amp EQ/reverb/delay too
 * when those precede NAM; crate's EQ and ampFx live in separate modules from
 * this detector, so replicating that exact call-site signal would need
 * decomposing ampFx's opaque pre/post bundle. An amplitude/bass-ratio
 * envelope follower is not meaningfully sensitive to a few dB of EQ or a
 * default-off (0 mix) pre-reverb/delay stage, so this runs on the gained
 * signal instead.
 */
function gainedMono(input: Float32Array, params: Record<string, number>): Float32Array {
  const padScale = (params.inputPad ?? 0) >= 0.5 ? 0.1 : 1;
  const inputGain = params.inputGain ?? 1;
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! * padScale * inputGain;
  return out;
}

/**
 * Per-sample morph blend position (0 = profile A, 1 = profile B), matching
 * `homecrate_ampDSPKernel::computeMorphTarget` + its 5ms one-pole slew
 * exactly: same envelope-follower math, same bass-content lowpass detector,
 * same threshold/sensitivity mapping.
 */
function computeMorphPositions(detectorInput: Float32Array, params: Record<string, number>, sampleRate: number): Float32Array {
  const atk = onePoleMs(params.morphAttack ?? 5, sampleRate);
  const rel = onePoleMs(params.morphRelease ?? 120, sampleRate);
  const bassSrc = (params.morphSource ?? 0) >= 0.5;

  // RBJ lowpass, ~180Hz Q 0.707, matching designMorphLowpass.
  const w0 = (2 * Math.PI * 180) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * 0.707);
  const a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0;
  const b1 = (1 - cosw) / a0;
  const b2 = (1 - cosw) / 2 / a0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  let lpX1 = 0;
  let lpX2 = 0;

  let morphEnv = 0;
  let morphBassEnv = 0;
  const target = new Float32Array(detectorInput.length);

  for (let i = 0; i < detectorInput.length; i++) {
    const x = detectorInput[i]!;
    const rect = Math.abs(x);
    morphEnv += (rect > morphEnv ? atk : rel) * (rect - morphEnv);

    let mapped: number;
    if (bassSrc) {
      const y = b0 * x + lpX1;
      lpX1 = b1 * x - a1 * y + lpX2;
      lpX2 = b2 * x - a2 * y;
      const rb = Math.abs(y);
      morphBassEnv += (rb > morphBassEnv ? atk : rel) * (rb - morphBassEnv);
      const ratio = clamp01(morphBassEnv / (morphEnv + 1e-9));
      const threshR = lerp(0.05, 0.55, params.morphThreshold ?? 0.35);
      const spanR = lerp(0.55, 0.1, params.morphSensitivity ?? 0.5);
      mapped = clamp01((ratio - threshR) / (spanR > 1e-4 ? spanR : 1e-4));
    } else {
      const envDb = 20 * Math.log10(morphEnv + 1e-9);
      const threshDb = lerp(-60, 0, params.morphThreshold ?? 0.35);
      const spanDb = lerp(40, 6, params.morphSensitivity ?? 0.5);
      mapped = clamp01((envDb - threshDb) / (spanDb > 1e-3 ? spanDb : 1e-3));
    }

    const swept = (params.morphInvert ?? 0) >= 0.5 ? 1 - mapped : mapped;
    target[i] = clamp01(lerp(params.morphManual ?? 0, swept, params.morphDepth ?? 0.75));
  }

  const slew = 1 - Math.exp(-1 / (0.005 * sampleRate));
  const pos = new Float32Array(detectorInput.length);
  let morphPos = params.morphManual ?? 0;
  for (let i = 0; i < detectorInput.length; i++) {
    morphPos += slew * (target[i]! - morphPos);
    pos[i] = morphPos;
  }
  return pos;
}

/**
 * Dynamic A/B morph: two full amp chains (profile A = primary namAsset,
 * profile B = the companion slot when its target is on, otherwise pinned
 * to A so that axis doesn't move), blended per-sample by the
 * envelope-follower position. Reverb/delay are identical, shared-parameter
 * engines in both chains fed the identical pre-NAM signal, so blending them
 * is mathematically a no-op (linear filter, same input, same coefficients);
 * only the NAM stage differs between chain A and B. Mono only: native's
 * morph is mutually exclusive with `stereoMode` (see `AudioMaterial.namAssetR`'s
 * doc comment).
 */
async function renderAmpMorphedMono(material: AudioMaterial, input: Float32Array, sampleRate: number, options: BakeAmpOptions): Promise<Float32Array> {
  const params = material.snapshotParams();
  const targetAmp = (params.morphTargetAmp ?? 1) >= 0.5;

  const chainA = await renderAmpChannel(material, input, sampleRate, options, { nam: 'primary' });
  const chainB = await renderAmpChannel(material, input, sampleRate, options, {
    nam: targetAmp ? 'secondary' : 'primary',
  });

  const morphPos = computeMorphPositions(gainedMono(input, params), params, sampleRate);
  const out = new Float32Array(input.length);
  for (let i = 0; i < out.length; i++) {
    const m = morphPos[i]!;
    out[i] = chainA[i]! * (1 - m) + chainB[i]! * m;
  }
  return out;
}

/**
 * Bake one amp chain. `stereoMode` off: mono downmix, broadcast. On with
 * two channels: independent L/R (`channelLink` / `volLink` / `invertR`).
 * `morphEnable` forces mono morph (same as native).
 */
export async function processAmpMaterial(material: AudioMaterial, channels: Float32Array[], sampleRate: number, options: BakeAmpOptions): Promise<Float32Array[]> {
  const morphEnable = material.getParam('morphEnable') >= 0.5;
  const stereoMode = material.getParam('stereoMode') >= 0.5;

  if (!morphEnable && stereoMode && channels.length >= 2) {
    const channelLink = material.getParam('channelLink') >= 0.5;
    const volLink = material.getParam('volLink') >= 0.5;
    const invertR = material.getParam('invertR') >= 0.5;

    const left = await renderAmpChannel(material, channels[0]!, sampleRate, options, { nam: 'primary' });
    let right = await renderAmpChannel(material, channels[1]!, sampleRate, options, {
      nam: channelLink ? 'primary' : 'secondary',
      inputGain: volLink ? undefined : material.getParam('inputGainR'),
      outputGain: volLink ? undefined : material.getParam('outputGainR'),
    });
    if (invertR) {
      const inverted = new Float32Array(right.length);
      for (let i = 0; i < right.length; i++) inverted[i] = -right[i]!;
      right = inverted;
    }
    const out = [left, right];
    for (let ch = 2; ch < channels.length; ch++) out.push(right);
    return out;
  }

  const mono = channels.length >= 2 ? average(channels[0]!, channels[1]!) : channels[0]!;
  const wet = morphEnable ? await renderAmpMorphedMono(material, mono, sampleRate, options) : await renderAmpChannel(material, mono, sampleRate, options);
  return channels.map(() => wet);
}

function average(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = 0.5 * (a[i]! + b[i]!);
  return out;
}
