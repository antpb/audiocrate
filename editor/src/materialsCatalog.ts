import { describeMaterial, type InspectorControl, type Material } from '../../src/index';
import { catalog, createMaterial, isToolEntry } from './catalog';
import { hasFileSlots } from './nodeAssets';
import {
  catalogSnapshot,
  formatJack,
  KERNEL_KINDS,
  type ModuleSnapshot,
} from './catalogSnapshot';

/**
 * One sentence per palette kind.
 * The test fails if a catalog kind is missing here.
 */
export const MATERIAL_NOTES: Record<string, string> = {
  keyboard: 'Host note source. cv is last-note 1V/oct. note/gate/velocity cables allocate poly voices.',
  midiclip: 'Piano-roll clip. Start, loop, pitch, rate, and velocity match Sample Player.',
  line: 'Live input from this machine\'s audio interface or mic. Device assignment is not sent to a session.',
  midiin:
    'Live MIDI input from one device on this machine. Device assignment is not sent to a session. Last-note analog like Keyboard. Channel 0 is omni. note/gate cables allocate poly voices.',
  midiout:
    'Live MIDI output to one device on this machine. Device assignment is not sent to a session. Gate holds the voice. Trig is the event: a pulse plus a note. Channel and message do sync.',
  master: 'The only output. Patch here to hear it.',
  oscillator: 'Keyboard voice. Eight waves, octave and detune, a short amp envelope.',
  tone: 'Free-running sine. Sounds on Play without a Keyboard. freq is a CV jack.',
  noise: 'Six spectral colors through a lowpass. White is flat, brown is rumble, blue and violet get brighter.',
  impulse: 'A one-sample click on a rising gate. For pinging filters and starting envelopes.',
  wavetable: 'Polyphonic scanner over eight single-cycle frames, or a loaded table of 256-sample frames.',
  sampleplayer: 'Plays a loaded file on a gate. Silent until you choose a file. Pitch is semitones.',
  SynthVoice: 'Subtractive voice: wave plus a detuned twin, a lowpass, and an amp envelope that can open the filter.',
  lowpass: 'RBJ biquad lowpass. Cutoff and Q.',
  highpass: 'RBJ biquad highpass. Cutoff and Q.',
  bandpass: 'RBJ biquad bandpass. Cutoff and Q.',
  notch: 'RBJ biquad notch. Cutoff and Q.',
  lowshelf: 'Low shelf. Gain at 0 dB is dry.',
  highshelf: 'High shelf. Gain at 0 dB is dry.',
  allpass: 'Phase shift without an amplitude change. Cutoff and Q.',
  onepolelowpass: 'Gentle one-pole lowpass. Cheap and well behaved when the cutoff moves.',
  onepolehighpass: 'Gentle one-pole highpass.',
  svflowpass: 'State-variable lowpass. Stays stable when cutoff is modulated hard.',
  svfhighpass: 'State-variable highpass.',
  svfbandpass: 'State-variable bandpass.',
  ladder: 'Resonant ladder lowpass. Resonance has character.',
  comb: 'Tuned comb. freq is the tooth spacing.',
  slopelowpass12: 'Fixed 12 dB/oct lowpass. No resonance control.',
  slopelowpass24: 'Fixed 24 dB/oct lowpass. No resonance control.',
  slopehighpass12: 'Fixed 12 dB/oct highpass. No resonance control.',
  ParametricEQ: 'Four-band channel EQ plus highpass and lowpass. Gains at 0 dB and filters off are dry.',
  compressor: 'Downward compressor with makeup and mix. Mix at 0 is dry.',
  limiter: 'Compressor locked to a high ratio.',
  gate: 'Opens when the envelope is above threshold.',
  expander: 'Turns quiet signals down.',
  transient: 'Boosts or cuts attack and sustain without a threshold.',
  ducker: 'Turns the main signal down when the sidechain is loud.',
  sidechaincomp: 'Compressor keyed by a second audio inlet named sidechain.',
  sidechaingate: 'Gate keyed by a second audio inlet named sidechain.',
  softclip: 'Smooth tanh saturation. Drive into it.',
  hardclip: 'Hard ceiling. Drive into it.',
  bitcrush: 'Lowers amplitude resolution. 16 bits is effectively clean.',
  downsample: 'Lowers time resolution. Factor is how many samples to hold.',
  fullrectify: 'Absolute value. Turns bipolar audio into unipolar.',
  halfrectify: 'Keeps the positive half, zeros the rest.',
  waveshape: 'Drive into a transfer curve, then mix with dry. Mix at 0 is bypass.',
  ringmod: 'Multiplies the input by a sine at freq.',
  delay: 'Echo with feedback. Mix at 0 is dry.',
  reverb: 'Six-comb tank plus two allpass-ish delays. Mix at 0 is dry.',
  synceddelay: 'Delay time is a note length, so it follows tempo.',
  pitchshift: 'Granular pitch shift in semitones. Mix at 0 is dry.',
  reverse: 'Plays short windows of the input backwards.',
  looper: 'Record captures. Play starts or restarts the loop, and closes a take when Record is still held. Bars 0 is free-running up to the ring. N bars auto-closes on that many measures. Threshold 0 is off; above 0, Record arms until a peak. Quantize snaps a free take. Start is a one-sample pulse on the first play sample after a take closes and on every wrap. End is a one-sample pulse on the last sample of the loop. Mix at 0 is dry.',
  transport: 'Host tempo and time signature. Params publish bpm, beatsPerBar, and beatUnit. Outlets are those fields plus beats, bars, playing, and a quarter-note pulse. Clock is free-running Hz. Synced Clock reads this snapshot.',
  clock: 'Free-running pulse train. Output is CV, not audio.',
  syncedclock: 'A pulse on each tempo division. Output is CV.',
  clockdivide: 'Passes one pulse every N incoming pulses.',
  clockmultiply: 'Emits extra pulses between incoming ones.',
  pulse: 'Turns an edge into a pulse of widthSec.',
  trigger: 'Fires when the input crosses threshold upward.',
  sequencer: 'Eight stepped values advanced by a clock. Output is CV.',
  randomsmooth: 'Smooth random bipolar CV at freq.',
  randomstepped: 'Stepped random bipolar CV at freq.',
  syncedramp: 'A 0..1 ramp locked to a tempo division.',
  syncedtremolo: 'Amplitude modulation locked to a tempo division.',
  lfo: 'Bipolar control oscillator. Same eight waves as Oscillator, at control rate.',
  adsr: 'Note-driven envelope. Times are live. Output is unipolar CV.',
  dahdsr: 'Delay, attack, hold, decay, sustain, release from a gate. Output is CV.',
  breakpoints: 'Four live time/level points from a gate. Later times clamp forward. Output is CV.',
  envfollow: 'Amplitude of the input as a control signal.',
  control: 'A constant you can automate or patch. Output is CV.',
  offset: 'Adds a constant to the input.',
  slew: 'Rate limiter with separate rise and fall speeds.',
  samplehold: 'Samples the input at freq and holds it.',
  comparegt: '1 when the input is above threshold, else 0.',
  comparelt: '1 when the input is below threshold, else 0.',
  logicand: 'AND of the input and other.',
  logicor: 'OR of the input and other.',
  logicxor: 'XOR of the input and other.',
  logicnot: 'Inverts a gate.',
  flipflop: 'Toggles on each rising edge.',
  quantize: 'Snaps a MIDI-style pitch number to a scale. Root and scale are menus.',
  euclidean: 'Evenly spaced hits across a step count, advanced by a clock.',
  rms: 'Windowed RMS of the input, as CV.',
  peak: 'Peak follower with a release time, as CV.',
  onset: 'Fires a pulse when a transient crosses threshold.',
  gain: 'Multiply. Gain at 1 is unity.',
  mix: 'Weighted sum of the main input plus three more constants-or-cables.',
  audiomix: 'Sums a second live audio inlet.',
  audiomultiply: 'Ring modulation by a second live audio inlet.',
  crossfade: 'Crossfade between the main input and a second live inlet.',
  inputselect: 'Hard switch between two live audio inlets.',
  select: 'Chooses between the main input and other.',
  invert: 'Flips polarity.',
  bypass: 'Passes the input through. A placeholder in a chain.',
  dcblock: 'Removes DC offset.',
  meter: 'Peak and RMS readout, also as CV. Audio still passes through.',
  scope: 'A window of samples for the inspector. Peak and RMS are CV. Audio still passes through.',
  analyzer: 'Meter plus spectrum. Note, cv, hz, cents, gate, peak, RMS, and LUFS are CV outlets so a patch can follow live playing.',
  tuner: 'Pitch readout of the incoming cable. Note, cv, hz, cents, and gate are CV outlets. Audio still passes through.',
  stereopan: 'Track-pan matrix: fold both sides, then equal-power position. Identity at center.',
  balance: 'Independent level per side.',
  autopan: 'Pans back and forth at rate.',
  haas: 'Width from a short delay on one side.',
  width: '0 collapses to mono, 1 is unity, above widens. The centre stays put.',
  monosum: 'Folds stereo to mono at the level a correlated pair started at.',
  monoleft: 'Copies the left channel to both sides.',
  monoright: 'Copies the right channel to both sides.',
  swap: 'Swaps left and right.',
  midside: 'Stereo to mid/side.',
  midsidedecode: 'Mid/side back to stereo.',
  stereomerge: 'Two live mono inlets into one stereo pair.',
  panleft: 'Equal-power gain for the left side of a pan pair.',
  panright: 'Equal-power gain for the right side of a pan pair.',
  spatialsource:
    'A sound placed in the room. x, y and z are metres, with -z ahead of the listener, and each is a CV jack, so an LFO on x sweeps the source past you. Global makes it omnidirectional. Its outlet is not audio: patch it into a Spatial Master.',
  spatialmaster:
    'Sums any number of Spatial Sources, turns the room to face the listener, and decodes it to headphones. Yaw and pitch are the listener\'s head, not the room. This is the node that goes to Master.',
  amp: 'Neural amp (NAM) plus analog / EQ / reverb / delay. Cabinet lives on an IR node after Amp.',
  grain: 'Granular instrument kernel. Needs WASM. Files are not auto-loaded.',
  synth: 'Subtractive synth kernel. Needs WASM.',
  spacereverb: 'Costello room kernel. Needs WASM.',
  ir: 'Convolution cabinet or space. Needs an impulse file.',
};

const FILE_SLOT: Record<string, string> = {
  amp: 'NAM profile (.nam). No profile is the analog path.',
  ir: 'Impulse (.wav, .aiff, .flac, ...).',
  sampleplayer: 'Sample. Silent until a file is loaded.',
  wavetable: 'Optional table. 512+ samples become 256-sample frames. Clear restores the factory bank.',
};

export function undocumentedKinds(): string[] {
  return catalog
    .filter((entry) => !entry.kind.startsWith('user.'))
    .map((entry) => entry.kind)
    .filter((kind) => !MATERIAL_NOTES[kind]);
}

export function formatMaterialsCatalog(): string {
  const groups = new Map<string, ModuleSnapshot[]>();
  for (const mod of catalogSnapshot()) {
    const list = groups.get(mod.category) ?? [];
    list.push(mod);
    groups.set(mod.category, list);
  }

  const lines = [
    '# Editor materials',
    '',
    'Palette modules and their parameters.',
    '',
    '`kind` is the crate.patch key. A menu param is an index, a switch is 0 or 1.',
    'A cable into a param jack is CV. Unipolar sources (ADSR, clocks) map 0 to min and 1 to max.',
    'Bipolar sources (LFO) map -1..1 across that range. At most ten param jacks (`MAX_CV_JACKS`).',
    '',
    'Generated from the catalog. After a Material change, run:',
    '',
    '```bash',
    'npm run test:editor',
    '```',
    '',
    'Amp, Grain, Synth, Space Reverb, and IR are WASM kernels, not ASL.',
    '',
    '## Contents',
    '',
  ];

  for (const category of groups.keys()) {
    lines.push(`- [${category}](#${category.toLowerCase()})`);
  }
  lines.push('');

  for (const [category, mods] of groups) {
    lines.push(`## ${category}`, '');
    for (const mod of mods) {
      lines.push(...formatEntry(mod), '');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function formatEntry(mod: ModuleSnapshot): string[] {
  const note = MATERIAL_NOTES[mod.kind] ?? '';
  const ins = mod.inputs.map((name) => formatJack(name, 'in', mod.kind)).join(', ') || 'none';
  const outs = mod.outputs.map((name) => formatJack(name, 'out', mod.kind)).join(', ') || 'none';
  const lines = [
    `### ${mod.label} (\`${mod.kind}\`)`,
    '',
    note,
    '',
    `- Jacks: in ${ins} / out ${outs}`,
  ];

  let material: Material | null = null;
  if (!KERNEL_KINDS.has(mod.kind) && !isToolKind(mod.kind)) {
    try {
      material = createMaterial(mod.kind);
    } catch {
      material = null;
    }
  }

  if (material) {
    if (material.polyphony > 1) {
      lines.push(`- Voices: ${material.polyphony} (${material.voiceStealing} steal)`);
    }
    if (material.kind !== 'transport' && (material.cvPolarity === 'unipolar' || material.kind === 'lfo')) {
      lines.push(`- Outlet: ${material.cvPolarity} CV (jack name cv)`);
    }
  }
  if (mod.kernel) lines.push('- Kernel: WASM. Cannot flatten to a crate.plugin graph.');
  if (hasFileSlots(mod.kind) && FILE_SLOT[mod.kind]) {
    lines.push(`- File: ${FILE_SLOT[mod.kind]}`);
  }

  const table = material ? controlTable(describeMaterial(material).controls) : snapshotTable(mod);
  if (table) {
    lines.push('', table);
  } else {
    lines.push('', 'No parameters.');
  }
  return lines;
}

function isToolKind(kind: string): boolean {
  const entry = catalog.find((item) => item.kind === kind);
  return entry ? isToolEntry(entry) : false;
}

function controlTable(controls: readonly InspectorControl[]): string | null {
  if (controls.length === 0) return null;
  const rows = [
    '| Param | Control | Range | Default | CV |',
    '|---|---|---|---|---|',
  ];
  for (const control of controls) {
    rows.push(
      `| \`${control.name}\` | ${control.kind} | ${rangeCell(control)} | ${escapeCell(control.display)} | ${control.automatable ? 'yes' : ''} |`,
    );
  }
  return rows.join('\n');
}

function snapshotTable(mod: ModuleSnapshot): string | null {
  if (mod.params.length === 0) return null;
  const rows = [
    '| Param | Range | Default |',
    '|---|---|---|',
  ];
  for (const param of mod.params) {
    let range: string;
    if (param.options && param.options.length > 0) {
      range = param.options.map((option, index) => `${index} ${option}`).join(', ');
    } else {
      const unit = param.unit ? ` ${param.unit}` : '';
      range = `${fmt(param.min)}..${fmt(param.max)}${unit}`;
    }
    rows.push(`| \`${param.name}\` | ${range} | ${fmt(param.default)} |`);
  }
  return rows.join('\n');
}

function rangeCell(control: InspectorControl): string {
  if (control.options && control.options.length > 0) {
    return control.options.map((option, index) => `${index} ${option}`).join(', ');
  }
  const unit = control.unit ? ` ${control.unit}` : '';
  const curve = control.curve && control.curve !== 'linear' ? ` ${control.curve}` : '';
  const step = control.step !== undefined && control.kind === 'stepper' ? ` step ${fmt(control.step)}` : '';
  return `${fmt(control.min)}..${fmt(control.max)}${unit}${curve}${step}`;
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 100) return String(Math.round(value));
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
