/**
 * `dsp/homecrate_drumDSPKernel.mm`, line for line: the per-pad 026S chain and
 * the master bus.
 *
 * One deliberate substitution. The AUv3 convolves through a partitioned
 * overlap-save FFT (`dsp/IRConvolver.cpp`); this runs the same impulse
 * response as a direct FIR. Same arithmetic result, minus two properties of
 * the wrapper rather than of the filter: the convolver buffers a whole
 * 512-sample partition before it emits anything, so the wet path lags the dry
 * one by `partition - hostBlock` samples, and vDSP's real FFT round trip
 * leaves the wet path at twice the mathematical convolution. The 2x is kept
 * here because it is audible and shipped. The latency is not, because it
 * changes with the host's block size.
 */
import {
  DEFAULT_IR_CUTOFF,
  DEFAULT_IR_LENGTH,
  DEFAULT_IR_RESONANCE,
  IR_FFT_GAIN,
} from '../drumConstants';
import { BitCrusher } from './BitCrusher';
import { CascadeFilter, CASCADE_LOWPASS } from './CascadeFilter';
import { SVFilter, SVF_LOWPASS } from './SVFilter';

export const NUM_PADS = 16;

export {
  DEFAULT_IR_CUTOFF,
  DEFAULT_IR_LENGTH,
  DEFAULT_IR_RESONANCE,
  IR_FFT_GAIN,
  IR_PART_SIZE,
} from '../drumConstants';

/** The bottom of the bit-crusher's sample-rate curve, in Hz. */
const LO_SR = 1000;

/**
 * `srParam` 0..1 to a rate ratio. Linear here puts everything audible below
 * 0.3, so the knob is a log sweep from ~1 kHz to native.
 */
export function srCurve(srParam: number, sampleRate: number): number {
  if (srParam >= 0.999) return 1;
  return Math.pow(LO_SR / sampleRate, 1 - srParam);
}

/**
 * Below 8 bits, truncation biases negative and the raw hold sits long runs
 * near -1. A linear trim from -2.5 dB at 4 bits back to unity at 8 keeps the
 * character and the headroom.
 */
export function bitTrim(bits: number): number {
  if (bits >= 8) return 1;
  return 0.75 + (bits - 4) * (0.25 / 4);
}

/** `synthesizeDefaultMasterIR`: a unit impulse through the character filter. */
export function defaultMasterIR(sampleRate: number, length = DEFAULT_IR_LENGTH): Float32Array {
  const designer = new CascadeFilter();
  designer.init(sampleRate);
  designer.setOrder(3);
  designer.setType(CASCADE_LOWPASS);
  designer.setCutoff(DEFAULT_IR_CUTOFF);
  designer.setResonance(DEFAULT_IR_RESONANCE);
  const ir = new Float32Array(length);
  for (let i = 0; i < length; i++) ir[i] = designer.process(i === 0 ? 1 : 0);
  return ir;
}

/** Direct FIR, standing in for the partitioned convolver. See the file note. */
class DirectConvolver {
  private history: Float32Array;
  private write = 0;

  constructor(private readonly ir: Float32Array) {
    this.history = new Float32Array(ir.length);
  }

  reset(): void {
    this.history.fill(0);
    this.write = 0;
  }

  process(x: number): number {
    const n = this.ir.length;
    this.history[this.write] = x;
    let sum = 0;
    let read = this.write;
    for (let i = 0; i < n; i++) {
      sum += this.ir[i]! * this.history[read]!;
      read = read === 0 ? n - 1 : read - 1;
    }
    this.write = this.write === n - 1 ? 0 : this.write + 1;
    return sum;
  }
}

export interface DrumKernelPadParams {
  srate: number;
  bits: number;
  cut: number;
  res: number;
}

export interface DrumKernelMasterParams {
  cut: number;
  res: number;
  irMix: number;
  vol: number;
  bypassPadDSP: boolean;
}

export const PAD_DEFAULTS: DrumKernelPadParams = { srate: 1, bits: 16, cut: 20000, res: 0 };
export const MASTER_DEFAULTS: DrumKernelMasterParams = {
  cut: 20000,
  res: 0,
  irMix: 0,
  vol: 1,
  bypassPadDSP: false,
};

export class DrumKernel {
  private readonly pads: DrumKernelPadParams[] = [];
  private readonly crusherL: BitCrusher[] = [];
  private readonly crusherR: BitCrusher[] = [];
  private readonly filterL: SVFilter[] = [];
  private readonly filterR: SVFilter[] = [];

  private master: DrumKernelMasterParams = { ...MASTER_DEFAULTS };
  private readonly masterFiltL = new CascadeFilter();
  private readonly masterFiltR = new CascadeFilter();
  private irL: DirectConvolver | null = null;
  private irR: DirectConvolver | null = null;

  constructor(private readonly sampleRate = 48000) {
    for (let i = 0; i < NUM_PADS; i++) {
      this.pads.push({ ...PAD_DEFAULTS });
      const cl = new BitCrusher();
      const cr = new BitCrusher();
      cl.init();
      cr.init();
      this.crusherL.push(cl);
      this.crusherR.push(cr);
      for (const [bank, f] of [
        [this.filterL, new SVFilter()],
        [this.filterR, new SVFilter()],
      ] as const) {
        f.init(sampleRate);
        f.setType(SVF_LOWPASS);
        f.setCutoff(PAD_DEFAULTS.cut);
        f.setResonance(PAD_DEFAULTS.res);
        (bank as SVFilter[]).push(f);
      }
    }
    for (const f of [this.masterFiltL, this.masterFiltR]) {
      f.init(sampleRate);
      f.setOrder(3);
      f.setType(CASCADE_LOWPASS);
      f.setCutoff(MASTER_DEFAULTS.cut);
      f.setResonance(MASTER_DEFAULTS.res);
    }
  }

  setPad(index: number, params: Partial<DrumKernelPadParams>): void {
    const pad = this.pads[index]!;
    if (params.srate !== undefined) pad.srate = params.srate;
    if (params.bits !== undefined) pad.bits = params.bits;
    if (params.cut !== undefined) {
      pad.cut = params.cut;
      this.filterL[index]!.setCutoff(params.cut);
      this.filterR[index]!.setCutoff(params.cut);
    }
    if (params.res !== undefined) {
      pad.res = params.res;
      this.filterL[index]!.setResonance(params.res);
      this.filterR[index]!.setResonance(params.res);
    }
  }

  setMaster(params: Partial<DrumKernelMasterParams>): void {
    if (params.cut !== undefined) {
      this.master.cut = params.cut;
      this.masterFiltL.setCutoff(params.cut);
      this.masterFiltR.setCutoff(params.cut);
    }
    if (params.res !== undefined) {
      this.master.res = params.res;
      this.masterFiltL.setResonance(params.res);
      this.masterFiltR.setResonance(params.res);
    }
    if (params.irMix !== undefined) this.master.irMix = params.irMix;
    if (params.vol !== undefined) this.master.vol = params.vol;
    if (params.bypassPadDSP !== undefined) this.master.bypassPadDSP = params.bypassPadDSP;
  }

  synthesizeDefaultMasterIR(): void {
    const ir = defaultMasterIR(this.sampleRate);
    this.irL = new DirectConvolver(ir);
    this.irR = new DirectConvolver(ir);
  }

  setUserMasterIR(samples: Float32Array): void {
    this.irL = new DirectConvolver(samples);
    this.irR = new DirectConvolver(samples);
  }

  clearMasterIR(): void {
    this.irL = null;
    this.irR = null;
  }

  /** `processPadInPlace`: bit crush, bit trim, then the per-pad low-pass. */
  processPadInPlace(padIdx: number, samplesL: Float32Array, samplesR: Float32Array, frames: number): void {
    if (frames <= 0 || padIdx < 0 || padIdx >= NUM_PADS) return;
    if (this.master.bypassPadDSP) return;

    const pad = this.pads[padIdx]!;
    const srCurved = srCurve(pad.srate, this.sampleRate);
    this.crusherL[padIdx]!.process(samplesL, frames, 1, pad.bits, srCurved);
    this.crusherR[padIdx]!.process(samplesR, frames, 1, pad.bits, srCurved);

    const norm = bitTrim(pad.bits);
    if (norm !== 1) {
      for (let i = 0; i < frames; i++) {
        samplesL[i] = samplesL[i]! * norm;
        samplesR[i] = samplesR[i]! * norm;
      }
    }

    const fL = this.filterL[padIdx]!;
    const fR = this.filterR[padIdx]!;
    for (let i = 0; i < frames; i++) {
      samplesL[i] = fL.process(samplesL[i]!);
      samplesR[i] = fR.process(samplesR[i]!);
    }
  }

  /** `processMasterBus`: cascade low-pass, IR dry/wet, output gain. */
  processMasterBus(outL: Float32Array, outR: Float32Array, frames: number): void {
    if (frames <= 0) return;

    for (let i = 0; i < frames; i++) {
      outL[i] = this.masterFiltL.process(outL[i]!);
      outR[i] = this.masterFiltR.process(outR[i]!);
    }

    const mix = this.master.irMix;
    if (this.irL && this.irR && mix >= 1e-4) {
      const dryGain = 1 - mix;
      for (let i = 0; i < frames; i++) {
        const wetL = this.irL.process(outL[i]!) * IR_FFT_GAIN;
        const wetR = this.irR.process(outR[i]!) * IR_FFT_GAIN;
        outL[i] = outL[i]! * dryGain + wetL * mix;
        outR[i] = outR[i]! * dryGain + wetR * mix;
      }
    }

    const g = this.master.vol;
    if (g < 0.999 || g > 1.001) {
      for (let i = 0; i < frames; i++) {
        outL[i] = outL[i]! * g;
        outR[i] = outR[i]! * g;
      }
    }
  }
}
