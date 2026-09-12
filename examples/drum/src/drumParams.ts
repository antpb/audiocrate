import { param, type ParamDescriptor } from './crate';

/**
 * The AUv3 parameter tree, addresses and all, from
 * `params/homecrate_drumParameterAddresses.swift`.
 *
 * Built with a loop rather than typed out: fifteen per-pad controls across
 * sixteen pads is 240 declarations that differ only in an index, and a
 * hand-written block of those is a place for one transposed address to hide.
 * The bases below are the only numbers, and `drumParams.test.ts` checks them
 * against the Swift enum.
 */

export const NUM_PADS = 16;

/** MIDI note of pad 0. Pads run C2..D#3, `padIndex = note - 36`. */
export const PAD_BASE_NOTE = 36;

/** First address of each per-pad bank. One entry per bank in the Swift enum. */
export const PAD_ADDRESS_BASE = {
  vol: 0,
  pitch: 16,
  srate: 32,
  bits: 48,
  cut: 64,
  res: 80,
  stretchOn: 101,
  stretchAmt: 117,
  character: 136,
  pan: 152,
  sampleStart: 168,
  sampleStop: 184,
  sampleFadeIn: 200,
  sampleFadeOut: 216,
  humanizeExempt: 233,
} as const;

export const MASTER_ADDRESS = {
  masterCut: 96,
  masterRes: 97,
  masterIRMix: 98,
  masterBypassPadDSP: 99,
  masterVol: 100,
  masterHumanize: 232,
} as const;

export type PadBank = keyof typeof PAD_ADDRESS_BASE;

/**
 * The suffix each bank uses in the AU's own identifiers, spelled out rather
 * than capitalised from the key. `srate` is `SRate` there, and deriving it
 * gives `Srate`, which loads nothing and reports no error.
 */
const PAD_SUFFIX: Record<PadBank, string> = {
  vol: 'Vol',
  pitch: 'Pitch',
  srate: 'SRate',
  bits: 'Bits',
  cut: 'Cut',
  res: 'Res',
  stretchOn: 'StretchOn',
  stretchAmt: 'StretchAmt',
  character: 'Character',
  pan: 'Pan',
  sampleStart: 'SampleStart',
  sampleStop: 'SampleStop',
  sampleFadeIn: 'SampleFadeIn',
  sampleFadeOut: 'SampleFadeOut',
  humanizeExempt: 'HumanizeExempt',
};

/** `pad7Cut`, the identifier the AU parameter tree uses. */
export function padParamName(bank: PadBank, pad: number): string {
  return `pad${pad}${PAD_SUFFIX[bank]}`;
}

type PadSpec = (pad: number, address: number) => ParamDescriptor;

const PAD_SPECS: Record<PadBank, PadSpec> = {
  vol: (pad, address) =>
    param.range(0, 1, { default: 1, unit: 'lin', address, label: `Pad ${pad} Volume` }),
  pitch: (pad, address) =>
    param.range(-24, 24, { default: 0, unit: 'st', address, label: `Pad ${pad} Pitch` }),
  srate: (pad, address) =>
    param.range(0, 1, { default: 1, address, label: `Pad ${pad} Sample Rate` }),
  // 4 is the floor the AU settled on: below it the quantisation step is so
  // coarse the residual offset reads as a broken plugin rather than lo-fi.
  bits: (pad, address) => param.range(4, 16, { default: 16, address, label: `Pad ${pad} Bits` }),
  cut: (pad, address) =>
    param.range(20, 20000, { default: 20000, unit: 'Hz', curve: 'log', address, label: `Pad ${pad} Cutoff` }),
  res: (pad, address) => param.range(0, 1, { default: 0, address, label: `Pad ${pad} Resonance` }),
  stretchOn: (pad, address) => param.toggle({ default: false, address, label: `Pad ${pad} Stretch` }),
  stretchAmt: (pad, address) =>
    param.range(0.5, 2, { default: 1, address, label: `Pad ${pad} Stretch Amount` }),
  character: (pad, address) =>
    param.range(-1, 1, { default: 0, address, label: `Pad ${pad} Character` }),
  pan: (pad, address) => param.range(-1, 1, { default: 0, address, label: `Pad ${pad} Pan` }),
  sampleStart: (pad, address) =>
    param.range(0, 1, { default: 0, address, label: `Pad ${pad} Start` }),
  sampleStop: (pad, address) => param.range(0, 1, { default: 1, address, label: `Pad ${pad} Stop` }),
  sampleFadeIn: (pad, address) =>
    param.range(0, 2000, { default: 0, unit: 'ms', address, label: `Pad ${pad} Fade In` }),
  sampleFadeOut: (pad, address) =>
    param.range(0, 2000, { default: 0, unit: 'ms', address, label: `Pad ${pad} Fade Out` }),
  humanizeExempt: (pad, address) =>
    param.toggle({ default: false, address, label: `Pad ${pad} Humanize Exempt` }),
};

function buildParams(): Record<string, ParamDescriptor> {
  const params: Record<string, ParamDescriptor> = {};
  for (const bank of Object.keys(PAD_SPECS) as PadBank[]) {
    const base = PAD_ADDRESS_BASE[bank];
    for (let pad = 0; pad < NUM_PADS; pad++) {
      params[padParamName(bank, pad)] = PAD_SPECS[bank](pad, base + pad);
    }
  }
  params.masterCut = param.range(20, 20000, {
    default: 20000,
    unit: 'Hz',
    curve: 'log',
    address: MASTER_ADDRESS.masterCut,
    label: 'Master Cutoff',
  });
  params.masterRes = param.range(0, 1, { default: 0, address: MASTER_ADDRESS.masterRes, label: 'Master Resonance' });
  params.masterIRMix = param.range(0, 1, { default: 0, address: MASTER_ADDRESS.masterIRMix, label: 'Master IR Mix' });
  params.masterBypassPadDSP = param.toggle({
    default: false,
    address: MASTER_ADDRESS.masterBypassPadDSP,
    label: 'Bypass 026S DSP',
  });
  params.masterVol = param.range(0, 1, { default: 1, unit: 'lin', address: MASTER_ADDRESS.masterVol, label: 'Master Volume' });
  params.masterHumanize = param.range(0, 1, {
    default: 0,
    address: MASTER_ADDRESS.masterHumanize,
    label: 'Master Humanize',
  });
  return params;
}

export const drumParams: Record<string, ParamDescriptor> = buildParams();

/**
 * Declared so a kit round-trips, but nothing in the graph reads them.
 *
 * Three of these are sampler plumbing that lives in the AU's Swift voice
 * rather than in `dsp/`: the SOLA stretch runs offline into a second buffer,
 * and Character and Humanize perturb velocity and timing at note-on. The
 * other three are playhead-relative envelope points, which the sample-player
 * node has no input for. README.md is the full list.
 */
export const INERT_PARAMS: readonly string[] = [
  ...(['stretchOn', 'stretchAmt', 'character', 'humanizeExempt', 'sampleStop', 'sampleFadeIn', 'sampleFadeOut'] as PadBank[]).flatMap(
    (bank) => Array.from({ length: NUM_PADS }, (_, pad) => padParamName(bank, pad)),
  ),
  'masterHumanize',
];

/** Everything the AU exposes to automation. */
export const drumAutomatable: readonly string[] = Object.keys(drumParams);
