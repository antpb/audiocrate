import { catalog, createMaterial, isToolEntry, type CatalogEntry } from './catalog';
import { nodeInputs, nodeOutputs } from './controlInputs';

export const KERNEL_KINDS = new Set(['amp', 'grain', 'synth', 'spacereverb', 'ir']);

const KERNEL_JACKS: Record<string, { inputs: readonly string[]; outputs: readonly string[]; note: string }> = {
  amp: {
    inputs: ['input'],
    outputs: ['audio'],
    note: 'kernel insert. NAM files are not auto-hydrated. Cabinet lives on an IR node after Amp. Cannot flatten. Listed params may be set.',
  },
  grain: {
    inputs: ['note', 'gate', 'velocity'],
    outputs: ['audio'],
    note: 'kernel instrument. Cannot flatten. Listed params may be set.',
  },
  synth: {
    inputs: ['note', 'gate', 'velocity'],
    outputs: ['audio'],
    note: 'kernel instrument. Cannot flatten. Listed params may be set.',
  },
  ir: {
    inputs: ['input'],
    outputs: ['audio'],
    note: 'kernel insert. Needs an IR file. Cannot flatten. Listed params may be set.',
  },
  spacereverb: {
    inputs: ['input'],
    outputs: ['audio'],
    note: 'kernel insert. Costello room. Cannot flatten. Listed params may be set.',
  },
};

const KERNEL_PARAMS: Record<string, ModuleSnapshot['params']> = {
  amp: [
    { name: 'inputGain', min: 0, max: 4, default: 1, unit: 'lin' },
    { name: 'outputGain', min: 0, max: 4, default: 1, unit: 'lin' },
    { name: 'eqBand0', min: -12, max: 12, default: 0, unit: 'dB' },
    { name: 'eqBand1', min: -12, max: 12, default: 0, unit: 'dB' },
    { name: 'eqBand2', min: -12, max: 12, default: 0, unit: 'dB' },
    { name: 'eqBand3', min: -12, max: 12, default: 0, unit: 'dB' },
    { name: 'eqBand4', min: -12, max: 12, default: 0, unit: 'dB' },
    { name: 'reverbBlend', min: 0, max: 1, default: 0 },
    { name: 'reverbDecay', min: 0, max: 1, default: 0.5 },
    { name: 'delayMix', min: 0, max: 1, default: 0 },
    { name: 'delayTime', min: 20, max: 2000, default: 350, unit: 'ms' },
    { name: 'inputPad', min: 0, max: 1, default: 0, unit: 'bool' },
  ],
  grain: [
    { name: 'grainMix', min: 0, max: 1, default: 0 },
    { name: 'grainSize', min: 20, max: 500, default: 120, unit: 'ms' },
    { name: 'grainDensity', min: 2, max: 80, default: 18, unit: 'Hz' },
    { name: 'grainPitch', min: -24, max: 24, default: 0, unit: 'st' },
    { name: 'inputGain', min: 0, max: 4, default: 1, unit: 'lin' },
    { name: 'outputGain', min: 0, max: 4, default: 1, unit: 'lin' },
    { name: 'loopLength', min: 0.25, max: 5, default: 2, unit: 's' },
    { name: 'dryLevel', min: 0, max: 1, default: 1 },
  ],
  synth: [
    { name: 'oscAWaveform', min: 0, max: 7, default: 2, unit: 'index' },
    { name: 'oscBWaveform', min: 0, max: 7, default: 0, unit: 'index' },
    { name: 'oscBlend', min: -1, max: 1, default: 0 },
    { name: 'ampAttack', min: 0.001, max: 5, default: 0.01, unit: 's' },
    { name: 'ampDecay', min: 0.001, max: 5, default: 0.3, unit: 's' },
    { name: 'ampSustain', min: 0, max: 1, default: 0.7 },
    { name: 'ampRelease', min: 0.001, max: 10, default: 0.5, unit: 's' },
    { name: 'filterCutoff', min: 20, max: 20000, default: 2000, unit: 'Hz' },
    { name: 'filterResonance', min: 0, max: 1, default: 0 },
    { name: 'masterGain', min: 0, max: 2, default: 0.8, unit: 'lin' },
    { name: 'delayMix', min: 0, max: 1, default: 0 },
    { name: 'reverbBlend', min: 0, max: 1, default: 0 },
  ],
  ir: [
    { name: 'mix', min: 0, max: 1, default: 1 },
    { name: 'gain', min: 0, max: 4, default: 1 },
  ],
  spacereverb: [
    { name: 'reverbBlend', min: 0, max: 1, default: 0.28 },
    { name: 'reverbDecay', min: 0, max: 1, default: 0.5 },
    { name: 'reverbSize', min: 0.5, max: 2, default: 1 },
    { name: 'reverbPreDelay', min: 0, max: 100, default: 0, unit: 'ms' },
    { name: 'reverbTone', min: 0, max: 1, default: 0.7 },
    { name: 'reverbGate', min: 0, max: 1, default: 0, unit: 'bool' },
  ],
};

export interface ModuleSnapshot {
  kind: string;
  label: string;
  category: string;
  kernel: boolean;
  inputs: readonly string[];
  outputs: readonly string[];
  params: readonly {
    name: string;
    min: number;
    max: number;
    default: number;
    unit?: string;
    options?: readonly string[];
  }[];
  note?: string;
}

function snapshotParams(material: { params: Record<string, { min: number; max: number; default: number; unit?: string; kind?: string; options?: readonly string[] }> }): ModuleSnapshot['params'] {
  return Object.entries(material.params).map(([name, descriptor]) => ({
    name,
    min: descriptor.min,
    max: descriptor.max,
    default: descriptor.default,
    ...(descriptor.unit ? { unit: descriptor.unit } : {}),
    ...(descriptor.kind === 'enum' && descriptor.options ? { options: descriptor.options } : {}),
  }));
}

function paramLines(entry: CatalogEntry): ModuleSnapshot['params'] {
  if (!entry.create) return [];
  try {
    return snapshotParams(createMaterial(entry.kind));
  } catch {
    return [];
  }
}

function snapshotEntry(entry: CatalogEntry): ModuleSnapshot {
  if (KERNEL_KINDS.has(entry.kind)) {
    const jacks = KERNEL_JACKS[entry.kind]!;
    return {
      kind: entry.kind,
      label: entry.label,
      category: entry.category,
      kernel: true,
      inputs: jacks.inputs,
      outputs: jacks.outputs,
      params: KERNEL_PARAMS[entry.kind] ?? [],
      note: jacks.note,
    };
  }
  if (isToolEntry(entry)) {
    return {
      kind: entry.kind,
      label: entry.label,
      category: entry.category,
      kernel: false,
      inputs: entry.inputs ?? [],
      outputs: entry.outputs ?? [],
      params: [],
    };
  }
  try {
    const material = createMaterial(entry.kind);
    return {
      kind: entry.kind,
      label: entry.label,
      category: entry.category,
      kernel: false,
      inputs: nodeInputs(material),
      outputs: nodeOutputs(material),
      params: snapshotParams(material),
      ...(entry.kind === 'ParametricEQ'
        ? {
            note: '4-band channel EQ plus HP/LP. lowType/highType 0=Shelf 1=Peak. Gains at 0 dB and filters off are dry.',
          }
        : {}),
    };
  } catch {
    return {
      kind: entry.kind,
      label: entry.label,
      category: entry.category,
      kernel: false,
      inputs: [],
      outputs: ['audio'],
      params: paramLines(entry),
    };
  }
}

let cached: ModuleSnapshot[] | null = null;

export function catalogSnapshot(): ModuleSnapshot[] {
  if (cached) return cached;
  cached = catalog
    .filter((entry) => !entry.kind.startsWith('user.'))
    .map(snapshotEntry);
  return cached;
}

const VOICE_JACKS = new Set(['note', 'gate', 'velocity', 'trig', 'clock', 'reset']);
const AUDIO_INLETS = new Set(['input', 'sidechain']);

/**
 * Bipolar modulators show an outlet named `audio` in the editor. The signal
 * is already CV. The catalog prints `audio(cv)` so a cable is not mistaken
 * for audio mix. Connection JSON still uses the jack name `audio`.
 */
const AUDIO_NAMED_CV = new Set([
  'sequencer',
  'euclidean',
  'randomsmooth',
  'randomstepped',
  'quantize',
  'slew',
  'samplehold',
  'offset',
  'control',
  'comparegt',
  'comparelt',
  'logicand',
  'logicor',
  'logicxor',
  'logicnot',
  'flipflop',
  'rms',
  'peak',
  'onset',
]);

export function formatJack(name: string, side: 'in' | 'out', kind: string): string {
  if (side === 'out') {
    if (name === 'audio' && AUDIO_NAMED_CV.has(kind)) return 'audio(cv)';
    return name;
  }
  if (VOICE_JACKS.has(name)) return name;
  if (AUDIO_INLETS.has(name)) return `${name}(audio)`;
  return `${name}(cv)`;
}
