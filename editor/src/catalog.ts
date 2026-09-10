/**
 * Palette for this editor. Core has no "list every Material" API and does
 * not name amp/grain/synth. Prototypes use `duplicate()`, registered plugins
 * use `create()`. Grain and IR ASL protos share kinds with the plugins, so
 * they stay under Plugins. Sample Player is silent until a file is loaded.
 */
import { KEYBOARD_KIND, KEYBOARD_OUTPUTS } from './analogKeyboard';
import { LINE_KIND, MASTER_KIND, MIDICLIP_KIND, MIDI_IN_KIND, MIDI_OUT_KIND } from './tools';
import {
  MIDI_IN_OUTPUTS,
  MIDI_OUT_INPUTS,
  adsrMaterial,
  allpassMaterial,
  analyzerMaterial,
  audioMixMaterial,
  audioMultiplyMaterial,
  autoPanMaterial,
  balanceMaterial,
  bandpassMaterial,
  bitcrushMaterial,
  breakpointEnvelopeMaterial,
  bypassMaterial,
  channelSwapMaterial,
  clockDivideMaterial,
  clockMaterial,
  clockMultiplyMaterial,
  combMaterial,
  compareGreaterMaterial,
  compareLessMaterial,
  compressorMaterial,
  controlMaterial,
  crossfadeMaterial,
  dahdsrMaterial,
  dcBlockerMaterial,
  delayMaterial,
  reverbMaterial,
  downsampleMaterial,
  duckerMaterial,
  envelopeFollowerMaterial,
  euclideanMaterial,
  expanderMaterial,
  flipFlopMaterial,
  fullRectifyMaterial,
  gainMaterial,
  gateMaterial,
  haasMaterial,
  halfRectifyMaterial,
  hardClipMaterial,
  highpassMaterial,
  highShelfMaterial,
  impulseMaterial,
  inputSelectMaterial,
  invertMaterial,
  ladderMaterial,
  lfoMaterial,
  limiterMaterial,
  logicAndMaterial,
  logicNotMaterial,
  logicOrMaterial,
  logicXorMaterial,
  looperMaterial,
  lowpassMaterial,
  lowShelfMaterial,
  materialRegistry,
  meterMaterial,
  midSideDecodeMaterial,
  midSideEncodeMaterial,
  mixMaterial,
  monoLeftMaterial,
  monoRightMaterial,
  monoSumMaterial,
  noiseMaterial,
  notchMaterial,
  offsetMaterial,
  onePoleHighpassMaterial,
  onePoleLowpassMaterial,
  onsetMaterial,
  oscillatorMaterial,
  toneMaterial,
  panLeftMaterial,
  panRightMaterial,
  parametricEqMaterial,
  peakMaterial,
  pitchShiftMaterial,
  pulseMaterial,
  quantizeMaterial,
  randomSmoothMaterial,
  randomSteppedMaterial,
  reverseMaterial,
  ringModMaterial,
  rmsMaterial,
  sampleHoldMaterial,
  samplePlayerMaterial,
  createSamplePlayerMaterial,
  createWavetableMaterial,
  scopeMaterial,
  selectMaterial,
  sequencerMaterial,
  sidechainCompressorMaterial,
  sidechainGateMaterial,
  slewMaterial,
  slopeHighpass12Material,
  slopeLowpass12Material,
  slopeLowpass24Material,
  softClipMaterial,
  spatialSourceMaterial,
  spatialMasterMaterial,
  stereoMergeMaterial,
  stereoPanMaterial,
  stereoWidthMaterial,
  svfBandpassMaterial,
  svfHighpassMaterial,
  svfLowpassMaterial,
  syncedClockMaterial,
  syncedDelayMaterial,
  transportMaterial,
  syncedRampMaterial,
  syncedTremoloMaterial,
  synthVoiceMaterial,
  transientMaterial,
  triggerMaterial,
  tunerMaterial,
  waveshapeMaterial,
  wavetableMaterial,
  type Material,
} from '../../src/index';

export type CatalogCategory =
  | 'Tools'
  | 'Sources'
  | 'Filters'
  | 'Dynamics'
  | 'Shape'
  | 'Time'
  | 'Control'
  | 'Routing'
  | 'Stereo'
  | 'Spatial'
  | 'Analysis'
  | 'Plugins';

export interface CatalogEntry {
  kind: string;
  label: string;
  category: CatalogCategory;
  role?: 'material' | 'tool';
  inputs?: readonly string[];
  outputs?: readonly string[];
  create?: () => Material;
}

type ProtoSpec = {
  proto: Material;
  category: Exclude<CatalogCategory, 'Tools' | 'Plugins'>;
  label?: string;
  create?: () => Material;
};

function fromProto(proto: Material, label?: string, create?: () => Material): CatalogEntry {
  return {
    kind: proto.kind,
    label: label ?? proto.name,
    category: 'Routing',
    create: create ?? (() => proto.duplicate()),
  };
}

function pluginEntry(kind: string, label: string, category: CatalogCategory): CatalogEntry {
  return {
    kind,
    label,
    category,
    create: () => {
      const plugin = materialRegistry.get(kind);
      if (!plugin) throw new Error(`No plugin registered for kind "${kind}"`);
      return plugin.create();
    },
  };
}

function tagged(entry: CatalogEntry, category: CatalogCategory): CatalogEntry {
  return { ...entry, category };
}

const CORE: ProtoSpec[] = [
  { proto: oscillatorMaterial, category: 'Sources' },
  { proto: toneMaterial, category: 'Sources' },
  { proto: noiseMaterial, category: 'Sources' },
  { proto: impulseMaterial, category: 'Sources' },
  { proto: wavetableMaterial, category: 'Sources', create: createWavetableMaterial },
  { proto: samplePlayerMaterial, category: 'Sources', label: 'Sample Player', create: createSamplePlayerMaterial },
  { proto: synthVoiceMaterial, category: 'Sources', label: 'Synth Voice' },
  { proto: lowpassMaterial, category: 'Filters' },
  { proto: highpassMaterial, category: 'Filters' },
  { proto: bandpassMaterial, category: 'Filters' },
  { proto: notchMaterial, category: 'Filters' },
  { proto: lowShelfMaterial, category: 'Filters', label: 'Low Shelf' },
  { proto: highShelfMaterial, category: 'Filters', label: 'High Shelf' },
  { proto: allpassMaterial, category: 'Filters' },
  { proto: onePoleLowpassMaterial, category: 'Filters', label: '1-Pole Lowpass' },
  { proto: onePoleHighpassMaterial, category: 'Filters', label: '1-Pole Highpass' },
  { proto: svfLowpassMaterial, category: 'Filters', label: 'SVF Lowpass' },
  { proto: svfHighpassMaterial, category: 'Filters', label: 'SVF Highpass' },
  { proto: svfBandpassMaterial, category: 'Filters', label: 'SVF Bandpass' },
  { proto: ladderMaterial, category: 'Filters' },
  { proto: combMaterial, category: 'Filters' },
  { proto: slopeLowpass12Material, category: 'Filters', label: 'LP 12 dB' },
  { proto: slopeLowpass24Material, category: 'Filters', label: 'LP 24 dB' },
  { proto: slopeHighpass12Material, category: 'Filters', label: 'HP 12 dB' },
  { proto: parametricEqMaterial, category: 'Filters', label: 'Parametric EQ' },
  { proto: compressorMaterial, category: 'Dynamics' },
  { proto: limiterMaterial, category: 'Dynamics' },
  { proto: gateMaterial, category: 'Dynamics' },
  { proto: expanderMaterial, category: 'Dynamics' },
  { proto: transientMaterial, category: 'Dynamics' },
  { proto: duckerMaterial, category: 'Dynamics' },
  { proto: sidechainCompressorMaterial, category: 'Dynamics', label: 'SC Comp' },
  { proto: sidechainGateMaterial, category: 'Dynamics', label: 'SC Gate' },
  { proto: softClipMaterial, category: 'Shape', label: 'Soft Clip' },
  { proto: hardClipMaterial, category: 'Shape', label: 'Hard Clip' },
  { proto: bitcrushMaterial, category: 'Shape' },
  { proto: downsampleMaterial, category: 'Shape' },
  { proto: fullRectifyMaterial, category: 'Shape', label: 'Full Rectify' },
  { proto: halfRectifyMaterial, category: 'Shape', label: 'Half Rectify' },
  { proto: waveshapeMaterial, category: 'Shape' },
  { proto: ringModMaterial, category: 'Shape', label: 'Ring Mod' },
  { proto: delayMaterial, category: 'Time' },
  { proto: reverbMaterial, category: 'Time' },
  { proto: syncedDelayMaterial, category: 'Time', label: 'Synced Delay' },
  { proto: pitchShiftMaterial, category: 'Time', label: 'Pitch Shift' },
  { proto: reverseMaterial, category: 'Time' },
  { proto: looperMaterial, category: 'Time' },
  { proto: transportMaterial, category: 'Time' },
  { proto: clockMaterial, category: 'Time' },
  { proto: syncedClockMaterial, category: 'Time', label: 'Synced Clock' },
  { proto: clockDivideMaterial, category: 'Time', label: 'Clock Divide' },
  { proto: clockMultiplyMaterial, category: 'Time', label: 'Clock Multiply' },
  { proto: pulseMaterial, category: 'Time' },
  { proto: triggerMaterial, category: 'Time' },
  { proto: sequencerMaterial, category: 'Time' },
  { proto: randomSmoothMaterial, category: 'Time', label: 'Smooth Random' },
  { proto: randomSteppedMaterial, category: 'Time', label: 'Stepped Random' },
  { proto: syncedRampMaterial, category: 'Time', label: 'Synced Ramp' },
  { proto: syncedTremoloMaterial, category: 'Time', label: 'Synced Tremolo' },
  { proto: lfoMaterial, category: 'Time' },
  { proto: adsrMaterial, category: 'Time' },
  { proto: dahdsrMaterial, category: 'Time' },
  { proto: breakpointEnvelopeMaterial, category: 'Time', label: 'Breakpoints' },
  { proto: envelopeFollowerMaterial, category: 'Time', label: 'Env Follow' },
  { proto: controlMaterial, category: 'Control' },
  { proto: offsetMaterial, category: 'Control' },
  { proto: slewMaterial, category: 'Control' },
  { proto: sampleHoldMaterial, category: 'Control', label: 'Sample & Hold' },
  { proto: compareGreaterMaterial, category: 'Control', label: 'Compare >' },
  { proto: compareLessMaterial, category: 'Control', label: 'Compare <' },
  { proto: logicAndMaterial, category: 'Control', label: 'AND' },
  { proto: logicOrMaterial, category: 'Control', label: 'OR' },
  { proto: logicXorMaterial, category: 'Control', label: 'XOR' },
  { proto: logicNotMaterial, category: 'Control', label: 'NOT' },
  { proto: flipFlopMaterial, category: 'Control', label: 'Flip Flop' },
  { proto: quantizeMaterial, category: 'Control' },
  { proto: euclideanMaterial, category: 'Control' },
  { proto: rmsMaterial, category: 'Control' },
  { proto: peakMaterial, category: 'Control' },
  { proto: onsetMaterial, category: 'Control' },
  { proto: gainMaterial, category: 'Routing' },
  { proto: mixMaterial, category: 'Routing' },
  { proto: audioMixMaterial, category: 'Routing', label: 'Audio Mix' },
  { proto: audioMultiplyMaterial, category: 'Routing', label: 'Audio Multiply' },
  { proto: crossfadeMaterial, category: 'Routing' },
  { proto: inputSelectMaterial, category: 'Routing', label: 'Input Select' },
  { proto: selectMaterial, category: 'Routing' },
  { proto: invertMaterial, category: 'Routing' },
  { proto: bypassMaterial, category: 'Routing' },
  { proto: dcBlockerMaterial, category: 'Routing', label: 'DC Block' },
  { proto: meterMaterial, category: 'Analysis' },
  { proto: scopeMaterial, category: 'Analysis' },
  { proto: analyzerMaterial, category: 'Analysis' },
  { proto: tunerMaterial, category: 'Analysis' },
  { proto: stereoPanMaterial, category: 'Stereo', label: 'Stereo Pan' },
  { proto: balanceMaterial, category: 'Stereo' },
  { proto: autoPanMaterial, category: 'Stereo', label: 'Auto Pan' },
  { proto: haasMaterial, category: 'Stereo' },
  { proto: stereoWidthMaterial, category: 'Stereo', label: 'Width' },
  { proto: monoSumMaterial, category: 'Stereo', label: 'Mono Sum' },
  { proto: monoLeftMaterial, category: 'Stereo', label: 'Mono Left' },
  { proto: monoRightMaterial, category: 'Stereo', label: 'Mono Right' },
  { proto: channelSwapMaterial, category: 'Stereo', label: 'Swap' },
  { proto: midSideEncodeMaterial, category: 'Stereo', label: 'M/S Encode' },
  { proto: midSideDecodeMaterial, category: 'Stereo', label: 'M/S Decode' },
  { proto: stereoMergeMaterial, category: 'Stereo', label: 'Stereo Merge' },
  { proto: panLeftMaterial, category: 'Stereo', label: 'Pan Left' },
  { proto: panRightMaterial, category: 'Stereo', label: 'Pan Right' },
  { proto: spatialSourceMaterial, category: 'Spatial', label: 'Spatial Source' },
  { proto: spatialMasterMaterial, category: 'Spatial', label: 'Spatial Master' },
];

export const coreProtos: Material[] = CORE.map((entry) => entry.proto);

export const catalog: CatalogEntry[] = [
  {
    kind: KEYBOARD_KIND,
    label: 'Keyboard',
    category: 'Tools',
    role: 'tool',
    outputs: KEYBOARD_OUTPUTS,
  },
  {
    kind: LINE_KIND,
    label: 'Line / Mic',
    category: 'Tools',
    role: 'tool',
    outputs: ['audio'],
  },
  {
    kind: MIDI_IN_KIND,
    label: 'MIDI In',
    category: 'Tools',
    role: 'tool',
    outputs: MIDI_IN_OUTPUTS,
  },
  {
    kind: MIDI_OUT_KIND,
    label: 'MIDI Out',
    category: 'Tools',
    role: 'tool',
    inputs: MIDI_OUT_INPUTS,
    outputs: [],
  },
  {
    kind: MIDICLIP_KIND,
    label: 'MIDI Clip',
    category: 'Tools',
    role: 'tool',
    outputs: KEYBOARD_OUTPUTS,
  },
  {
    kind: MASTER_KIND,
    label: 'Master',
    category: 'Tools',
    role: 'tool',
    inputs: ['input'],
    outputs: [],
  },
  ...CORE.map((entry) => tagged(fromProto(entry.proto, entry.label, entry.create), entry.category)),
  pluginEntry('amp', 'Amp', 'Plugins'),
  pluginEntry('grain', 'Grain', 'Plugins'),
  pluginEntry('synth', 'Synth', 'Plugins'),
  pluginEntry('spacereverb', 'Space Reverb', 'Plugins'),
  pluginEntry('ir', 'IR', 'Plugins'),
];

const byKind = new Map(catalog.map((entry) => [entry.kind, entry]));

export function catalogEntry(kind: string): CatalogEntry | undefined {
  return byKind.get(kind);
}

/** Adds or replaces a palette entry, e.g. a plugin exported this session. */
export function addCatalogEntry(entry: CatalogEntry): void {
  const existing = byKind.get(entry.kind);
  if (existing) {
    Object.assign(existing, entry);
    return;
  }
  catalog.push(entry);
  byKind.set(entry.kind, entry);
}

export function createMaterial(kind: string): Material {
  const entry = catalogEntry(kind);
  if (!entry) throw new Error(`Unknown material kind "${kind}"`);
  if (!entry.create) throw new Error(`"${kind}" is a tool, not a Material`);
  return entry.create();
}

export function isToolEntry(entry: CatalogEntry): boolean {
  return entry.role === 'tool';
}

export function categories(): CatalogCategory[] {
  return [
    'Tools',
    'Sources',
    'Filters',
    'Dynamics',
    'Shape',
    'Time',
    'Control',
    'Routing',
    'Stereo',
    'Spatial',
    'Analysis',
    'Plugins',
  ];
}
