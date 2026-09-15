/**
 * Palette for this editor. Core has no "list every AudioMaterial" API and does
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
  audioMaterialRegistry,
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
  type AudioMaterial,
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
  /** One sentence for the palette. User-exported plugins may omit it. */
  blurb?: string;
  role?: 'material' | 'tool';
  inputs?: readonly string[];
  outputs?: readonly string[];
  create?: () => AudioMaterial;
}

/**
 * Palette copy. Longer notes for the generated materials page live in
 * `MATERIAL_NOTES`; these stay short enough to scan in the sidebar.
 */
export const PALETTE_BLURBS: Record<string, string> = {
  keyboard: 'Host keys. Note, gate, velocity, and 1V/oct for the voices they play.',
  midiclip: 'Piano-roll clip that plays like a keyboard.',
  line: 'Live input from this machine\'s interface or mic.',
  midiin: 'Live MIDI from one device on this machine.',
  midiout: 'Live MIDI to one device on this machine.',
  master: 'The only output. Patch here to hear it.',
  oscillator: 'Polyphonic oscillator with eight waves and an amp envelope.',
  tone: 'Free-running sine. Sounds on Play without a keyboard.',
  noise: 'Six spectral colors through a lowpass.',
  impulse: 'A one-sample click on a rising gate.',
  wavetable: 'Polyphonic scanner over single-cycle frames.',
  sampleplayer: 'Plays a loaded file on a gate. Silent until a file is chosen.',
  SynthVoice: 'Subtractive voice: wave, unison, lowpass, and an amp envelope.',
  lowpass: 'Biquad lowpass. Cutoff and Q.',
  highpass: 'Biquad highpass. Cutoff and Q.',
  bandpass: 'Biquad bandpass. Cutoff and Q.',
  notch: 'Biquad notch. Cutoff and Q.',
  lowshelf: 'Boosts or cuts the lows. Gain at 0 dB is dry.',
  highshelf: 'Boosts or cuts the highs. Gain at 0 dB is dry.',
  allpass: 'Phase shift without changing amplitude.',
  onepolelowpass: 'Gentle one-pole lowpass, stable when cutoff moves.',
  onepolehighpass: 'Gentle one-pole highpass.',
  svflowpass: 'State-variable lowpass, stable under fast cutoff moves.',
  svfhighpass: 'State-variable highpass.',
  svfbandpass: 'State-variable bandpass.',
  ladder: 'Resonant ladder lowpass with drive.',
  comb: 'Tuned comb filter.',
  slopelowpass12: 'Fixed 12 dB/oct lowpass. No resonance control.',
  slopelowpass24: 'Fixed 24 dB/oct lowpass. No resonance control.',
  slopehighpass12: 'Fixed 12 dB/oct highpass. No resonance control.',
  ParametricEQ: 'Four-band channel EQ plus highpass and lowpass.',
  compressor: 'Downward compressor with makeup and mix.',
  limiter: 'Compressor locked to a high ratio.',
  gate: 'Opens when the envelope is above threshold.',
  expander: 'Turns quiet signals down.',
  transient: 'Boosts or cuts attack and sustain independently of level.',
  ducker: 'Turns the main signal down when the sidechain is loud.',
  sidechaincomp: 'Compressor keyed by a second audio inlet.',
  sidechaingate: 'Gate keyed by a second audio inlet.',
  softclip: 'Smooth tanh saturation.',
  hardclip: 'Hard ceiling.',
  bitcrush: 'Lowers amplitude resolution.',
  downsample: 'Lowers time resolution.',
  fullrectify: 'Absolute value. Bipolar audio becomes unipolar.',
  halfrectify: 'Keeps the positive half, zeros the rest.',
  waveshape: 'Drive into a transfer curve, then mix with dry.',
  ringmod: 'Multiplies the input by a sine.',
  delay: 'Echo with feedback. Mix at 0 is dry.',
  reverb: 'Comb-tank room. Mix at 0 is dry.',
  synceddelay: 'Delay time is a note length, so it follows tempo.',
  pitchshift: 'Granular pitch shift in semitones.',
  reverse: 'Plays short windows of the input backwards.',
  looper: 'Record, play, and overdub a loop.',
  transport: 'Host tempo and time signature.',
  clock: 'Free-running pulse train. Output is CV.',
  syncedclock: 'A pulse on each tempo division. Output is CV.',
  clockdivide: 'Passes one pulse every N incoming pulses.',
  clockmultiply: 'Emits extra pulses between incoming ones.',
  pulse: 'Turns an edge into a pulse of fixed width.',
  trigger: 'Fires when the input crosses threshold upward.',
  sequencer: 'Eight stepped values advanced by a clock.',
  randomsmooth: 'Smooth random bipolar CV.',
  randomstepped: 'Stepped random bipolar CV.',
  syncedramp: 'A 0..1 ramp locked to a tempo division.',
  syncedtremolo: 'Amplitude modulation locked to the beat.',
  lfo: 'Bipolar control oscillator. Same eight waves as Oscillator.',
  adsr: 'Note-driven envelope. Output is unipolar CV.',
  dahdsr: 'Delay, attack, hold, decay, sustain, release from a gate.',
  breakpoints: 'Four live time/level points from a gate.',
  envfollow: 'Amplitude of the input as a control signal.',
  control: 'A constant you can automate or patch.',
  offset: 'Adds a constant to the input.',
  slew: 'Rate limiter with separate rise and fall.',
  samplehold: 'Samples the input at a clock and holds it.',
  comparegt: '1 when the input is above threshold, else 0.',
  comparelt: '1 when the input is below threshold, else 0.',
  logicand: 'AND of the input and a second signal.',
  logicor: 'OR of the input and a second signal.',
  logicxor: 'XOR of the input and a second signal.',
  logicnot: 'Inverts a gate.',
  flipflop: 'Toggles on each rising edge.',
  quantize: 'Snaps a pitch number to a scale.',
  euclidean: 'Evenly spaced hits across a step count.',
  rms: 'Windowed RMS of the input, as CV.',
  peak: 'Peak follower with a release time, as CV.',
  onset: 'Fires a pulse when a transient crosses threshold.',
  gain: 'Multiply. Gain at 1 is unity.',
  mix: 'Weighted sum of the main input plus three more.',
  audiomix: 'Sums a second live audio inlet.',
  audiomultiply: 'Ring modulation by a second live audio inlet.',
  crossfade: 'Crossfade between the main input and a second inlet.',
  inputselect: 'Hard switch between two live audio inlets.',
  select: 'Chooses between the main input and other.',
  invert: 'Flips polarity.',
  bypass: 'Passes the input through. A placeholder in a chain.',
  dcblock: 'Removes DC offset.',
  meter: 'Peak and RMS readout. Audio still passes through.',
  scope: 'A window of samples for the inspector. Audio still passes through.',
  analyzer: 'Meter plus spectrum, with pitch CV outlets.',
  tuner: 'Pitch readout of the incoming cable.',
  stereopan: 'True stereo pan, not two mono gains.',
  balance: 'Independent level per side.',
  autopan: 'Pans back and forth at a rate.',
  haas: 'Width from a short delay on one side.',
  width: '0 collapses to mono, 1 is unity, above widens.',
  monosum: 'Folds stereo to mono.',
  monoleft: 'Copies the left channel to both sides.',
  monoright: 'Copies the right channel to both sides.',
  swap: 'Swaps left and right.',
  midside: 'Stereo to mid/side.',
  midsidedecode: 'Mid/side back to stereo.',
  stereomerge: 'Two live mono inlets into one stereo pair.',
  panleft: 'Equal-power gain for the left side of a pan pair.',
  panright: 'Equal-power gain for the right side of a pan pair.',
  spatialsource: 'A sound placed in the room. Patch into a Spatial Master.',
  spatialmaster: 'Sums Spatial Sources and decodes them to headphones.',
  amp: 'Neural amp plus analog, EQ, reverb, and delay.',
  drum: 'Sixteen one-shot pads into a shared filter and character stage.',
  grain: 'Granular instrument kernel. Needs WASM.',
  synth: 'Subtractive synth kernel. Needs WASM.',
  spacereverb: 'Costello room kernel. Needs WASM.',
  ir: 'Convolution cabinet or space. Needs an impulse file.',
};

function withBlurb(entry: CatalogEntry): CatalogEntry {
  const blurb = entry.blurb ?? PALETTE_BLURBS[entry.kind];
  return blurb ? { ...entry, blurb } : entry;
}

type ProtoSpec = {
  proto: AudioMaterial;
  category: Exclude<CatalogCategory, 'Tools' | 'Plugins'>;
  label?: string;
  create?: () => AudioMaterial;
};

function fromProto(proto: AudioMaterial, label?: string, create?: () => AudioMaterial): CatalogEntry {
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
      const plugin = audioMaterialRegistry.get(kind);
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

export const coreProtos: AudioMaterial[] = CORE.map((entry) => entry.proto);

const catalogDraft: CatalogEntry[] = [
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
  pluginEntry('drum', 'Drum', 'Plugins'),
  pluginEntry('grain', 'Grain', 'Plugins'),
  pluginEntry('synth', 'Synth', 'Plugins'),
  pluginEntry('spacereverb', 'Space Reverb', 'Plugins'),
  pluginEntry('ir', 'IR', 'Plugins'),
];

export const catalog: CatalogEntry[] = catalogDraft.map(withBlurb);

const byKind = new Map(catalog.map((entry) => [entry.kind, entry]));

export function catalogEntry(kind: string): CatalogEntry | undefined {
  return byKind.get(kind);
}

/** Adds or replaces a palette entry, e.g. a plugin exported this session. */
export function addCatalogEntry(entry: CatalogEntry): void {
  const next = withBlurb(entry);
  const existing = byKind.get(next.kind);
  if (existing) {
    Object.assign(existing, next);
    return;
  }
  catalog.push(next);
  byKind.set(next.kind, next);
}

export function missingPaletteBlurbs(): string[] {
  return catalog
    .filter((entry) => !entry.kind.startsWith('user.'))
    .filter((entry) => !entry.blurb)
    .map((entry) => entry.kind);
}

export function createMaterial(kind: string): AudioMaterial {
  const entry = catalogEntry(kind);
  if (!entry) throw new Error(`Unknown material kind "${kind}"`);
  if (!entry.create) throw new Error(`"${kind}" is a tool, not an AudioMaterial`);
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
