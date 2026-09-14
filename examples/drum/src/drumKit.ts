import type { AudioMaterial } from './crate';
import { NUM_PADS, padParamName } from './drumParams';

/**
 * The kit a fresh drum starts with.
 *
 * The AUv3 and the VST3 both seed one when a new plugin is added, which is
 * what makes a drum audible the moment it exists rather than sixteen silent
 * pads. The values are the shipping kit's, from `homecrateDrumDefaultKitState`
 * in the host's `RecorderPluginModule.swift`, and the sample names are the
 * files in `assets/`.
 *
 * This is data, not loading. A caller supplies the decoded audio, because
 * where the files come from is the host's business: the plugin reads an App
 * Group sample library, the editor imports them as bundled assets.
 */

/** Pad labels from the reference kit, in pad order. */
export const FACTORY_PAD_LABELS: readonly string[] = [
  'KICK',
  'RIM',
  'SNARE 1',
  'CLAP',
  'SNARE 2',
  'LO FLR TM',
  'HH CL',
  'HI FLR TM',
  'HH PED',
  'LO TOM',
  'HH OP',
  'LO-MID TM',
  'HI-MID TM',
  'CRASH 1',
  'HI TOM',
  'RIDE',
];

/**
 * Pad to sample file.
 *
 * Toms reuse a smaller set of recordings (both floor toms and the high tom
 * come off two files) and the per-pad pitch below retunes each reuse toward
 * the drum it stands in for.
 */
export const FACTORY_PAD_SAMPLES: readonly string[] = [
  'homecrate_kick2.wav',
  'homecrate_rim.wav',
  'homecrate_snare1.wav',
  'homecrate_clap.wav',
  'homecrate_snare2.wav',
  'homecrate_lowtom.wav',
  'homecrate_hhcl.wav',
  'homecrate_hitom.wav',
  'homecrate_hhpdl.wav',
  'homecrate_lowtom.wav',
  'homecrate_hhopn.wav',
  'homecrate_lowtom.wav',
  'homecrate_himidtom.wav',
  'homecrate_crash.wav',
  'homecrate_hitom.wav',
  'homecrate_ride.wav',
];

/** Every file the kit needs, each named once. */
export const FACTORY_KIT_FILES: readonly string[] = [...new Set(FACTORY_PAD_SAMPLES)];

const VOL = [
  0.7194444537162781, 0.5944444537162781, 0.736111044883728, 0.7805555462837219, 0.7805555462837219,
  0.4611111581325531, 0.2722221910953522, 0.2527778148651123, 0.6694445013999939, 0.5805555582046509,
  0.7472221851348877, 0.48888885974884033, 1.0, 0.09444445371627808, 0.0, 0.11166670173406601,
];
const PITCH = [-1, 0, 2, -4, 0, 0, 0, -2, 0, 0, 0, 4, 0, 4, 0, -1];
const BITS = [12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 16, 16, 12, 16];
const CUT = [
  19844.6015625, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000,
  20000, 20000, 20000,
];
const RES = [
  0.3111112713813782, 0.1100001260638237, 0.3477775454521179, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
const STRETCH_ON = [1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
const STRETCH_AMT = [
  0.9933196306228638, 1.001666784286499, 1.4083324670791626, 1.0, 1.0, 0.9533333778381348, 1.0,
  0.7700001001358032, 1.0, 1.0, 1.0, 1.0016670227050781, 1.0, 1.0, 0.9950000047683716, 1.0,
];
const CHARACTER = [
  -0.13777774572372437, 0.22666668891906738, -0.8600001335144043, -0.9733335375785828, -1.0,
  -0.7244443893432617, -0.37777823209762573, 0.0, -0.3444444537162781, -0.5666667222976685, 0.0,
  -0.7044445276260376, -0.6311109066009521, 0.0, -0.8488889336585999, -1.0,
];

/** The kit's parameter values, by param name. */
export function factoryKitParams(): Record<string, number> {
  const params: Record<string, number> = {};
  for (let pad = 0; pad < NUM_PADS; pad++) {
    params[padParamName('vol', pad)] = VOL[pad]!;
    params[padParamName('pitch', pad)] = PITCH[pad]!;
    params[padParamName('srate', pad)] = 1;
    params[padParamName('bits', pad)] = BITS[pad]!;
    params[padParamName('cut', pad)] = CUT[pad]!;
    params[padParamName('res', pad)] = RES[pad]!;
    params[padParamName('stretchOn', pad)] = STRETCH_ON[pad]!;
    params[padParamName('stretchAmt', pad)] = STRETCH_AMT[pad]!;
    params[padParamName('character', pad)] = CHARACTER[pad]!;
  }
  params.masterCut = 20000;
  params.masterRes = 0;
  // The kit is voiced through the character filter, not around it.
  params.masterIRMix = 1;
  params.masterBypassPadDSP = 0;
  params.masterVol = 1;
  params.masterHumanize = 0;
  return params;
}

export function applyFactoryKitParams(material: AudioMaterial): void {
  for (const [name, value] of Object.entries(factoryKitParams())) {
    material.setParam(name, value);
  }
}
