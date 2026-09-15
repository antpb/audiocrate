/**
 * The patches the crate plugin ships with, ported from
 * `CrateFactoryPatches.swift`.
 *
 * These are crate.patch documents rather than compiled crate.plugin files.
 * A compiled graph can be played and nothing else; a patch opens on the
 * canvas with every node and cable where the author left them, so a starting
 * point is also a worked example.
 */
import { catalog, createMaterial } from './catalog';
import { applyPatchLayout } from './patchLayout';
import { PATCH_KIND, PATCH_VERSION, type CratePatch, type PatchConnection, type PatchNode } from './patch';

export type FactorySlot = 'instrument' | 'effect' | 'either';

export interface FactoryPatch {
  id: string;
  name: string;
  category: string;
  blurb: string;
  slot: FactorySlot;
  patch: CratePatch;
}

export const FACTORY_CATEGORY_ORDER = [
  'Bass',
  'Lead',
  'Pad',
  'Keys & Pluck',
  'Percussion',
  'Plays Itself',
  'Filter & Tone',
  'Drive & Crush',
  'Delay',
  'Reverb & Space',
  'Modulation',
  'Dynamics',
  'Stereo & Width',
];

export function factoryPatchFits(entry: FactoryPatch, slot: FactorySlot): boolean {
  return entry.slot === slot || entry.slot === 'either';
}

export function factoryPatchById(id: string): FactoryPatch | undefined {
  return FACTORY_PATCHES.find((entry) => entry.id === id);
}

export function groupedFactoryPatches(
  slot?: FactorySlot | null,
): { category: string; patches: FactoryPatch[] }[] {
  const visible = slot ? FACTORY_PATCHES.filter((entry) => factoryPatchFits(entry, slot)) : FACTORY_PATCHES;
  return FACTORY_CATEGORY_ORDER.flatMap((category) => {
    const patches = visible.filter((entry) => entry.category === category);
    return patches.length === 0 ? [] : [{ category, patches }];
  });
}

function n(id: string, kind: string, params: Record<string, number> = {}): PatchNode {
  return { id, kind, x: 0, y: 0, params };
}

function vca(id: string): PatchNode {
  return n(id, 'gain', { gain: 0 });
}

function w(source: string, jack: string, target: string, inlet: string): PatchConnection {
  return { source, sourceOutput: jack, target, targetInput: inlet };
}

function series(ids: string[]): PatchConnection[] {
  const cables: PatchConnection[] = [];
  for (let i = 0; i < ids.length - 1; i += 1) {
    cables.push(w(ids[i], 'audio', ids[i + 1], 'input'));
  }
  return cables;
}

function midi(note: number): number {
  return (note - 60) / 12;
}

const Div = {
  whole: 0,
  half: 1,
  dottedHalf: 2,
  quarter: 3,
  dottedQuarter: 4,
  tripletQuarter: 5,
  eighth: 6,
  dottedEighth: 7,
  tripletEighth: 8,
  sixteenth: 9,
  tripletSixteenth: 10,
} as const;

const Wave = {
  sine: 0,
  saw: 1,
  square: 2,
  triangle: 3,
  pulse: 4,
  varShape: 5,
  superSquare: 6,
  harmonic: 7,
} as const;

const Noise = {
  white: 0,
  pink: 1,
  brown: 2,
  blue: 3,
  violet: 4,
  grey: 5,
} as const;

const Curve = {
  soft: 0,
  hard: 1,
  fold: 2,
  asym: 3,
  sine: 4,
} as const;

interface Mod {
  id: string;
  source: string;
  jack: string;
  target: string;
  inlet: string;
  low: number;
  high: number;
}

function mod(
  id: string,
  source: string,
  jack: string,
  target: string,
  inlet: string,
  low: number,
  high: number,
): Mod {
  return { id, source, jack, target, inlet, low, high };
}

let declaredRanges: Map<string, { min: number; max: number }> | null = null;

function rangeFor(kind: string, inlet: string): { min: number; max: number } {
  if (!declaredRanges) {
    declaredRanges = new Map();
    for (const entry of catalog) {
      if (!entry.create) continue;
      try {
        const material = createMaterial(entry.kind);
        for (const [name, descriptor] of Object.entries(material.params)) {
          if (descriptor.min < descriptor.max) {
            declaredRanges.set(`${material.kind}.${name}`, { min: descriptor.min, max: descriptor.max });
          }
        }
      } catch {
        /* tools and missing plugins stay on the wire-unit fallback */
      }
    }
  }
  return declaredRanges.get(`${kind}.${inlet}`) ?? { min: -1, max: 1 };
}

const UNIPOLAR_SOURCES = new Set(['adsr', 'dahdsr', 'envfollow']);

function expand(mods: Mod[], kinds: Record<string, string>): { nodes: PatchNode[]; wires: PatchConnection[] } {
  const nodes: PatchNode[] = [];
  const wires: PatchConnection[] = [];
  for (const spec of mods) {
    const range = rangeFor(kinds[spec.target] ?? '', spec.inlet);
    const wire = (value: number) =>
      (2 * (value - range.min)) / (range.max - range.min) - 1;
    const low = wire(spec.low);
    const high = wire(spec.high);
    const unipolar = UNIPOLAR_SOURCES.has(kinds[spec.source] ?? '');
    const centre = unipolar ? low : (low + high) / 2;
    const span = unipolar ? high - low : Math.abs(high - low) / 2;
    const amount = Math.min(4, Math.max(0, span));
    const depth = `${spec.id}amt`;
    const centred = `${spec.id}mid`;
    nodes.push(n(depth, 'gain', { gain: amount }));
    nodes.push(n(centred, 'offset', { amount: Math.min(2, Math.max(-2, centre)) }));
    wires.push(w(spec.source, spec.jack, depth, 'input'));
    wires.push(w(depth, 'audio', centred, 'input'));
    wires.push(w(centred, 'audio', spec.target, spec.inlet));
  }
  return { nodes, wires };
}

const keysId = 'keys';
const lineId = 'line';
const masterId = 'out';
const songId = 'song';

function kindMap(nodes: PatchNode[]): Record<string, string> {
  return Object.fromEntries(nodes.map((node) => [node.id, node.kind]));
}

function finish(nodes: PatchNode[], connections: PatchConnection[]): CratePatch {
  return applyPatchLayout({
    version: PATCH_VERSION,
    kind: PATCH_KIND,
    nodes,
    connections,
  });
}

function inst(
  id: string,
  name: string,
  category: string,
  blurb: string,
  spec: {
    nodes: PatchNode[];
    voices?: string[];
    gates?: string[];
    path: string[];
    level: number;
    mods?: Mod[];
    wires?: PatchConnection[];
  },
): FactoryPatch {
  const { nodes: modNodes, wires: modWires } = expand(spec.mods ?? [], kindMap(spec.nodes));
  const path = [...spec.path, 'lvl', 'lim'];
  const cables: PatchConnection[] = [];
  for (const voice of spec.voices ?? []) {
    cables.push(w(keysId, 'cv', voice, 'note'));
    cables.push(w(keysId, 'gate', voice, 'gate'));
  }
  for (const gate of spec.gates ?? []) {
    cables.push(w(keysId, 'cv', gate, 'note'));
    cables.push(w(keysId, 'gate', gate, 'gate'));
  }
  cables.push(...series(path));
  const last = path[path.length - 1];
  if (last) cables.push(w(last, 'audio', masterId, 'input'));
  cables.push(...modWires, ...(spec.wires ?? []));
  return {
    id,
    name,
    category,
    blurb,
    slot: 'instrument',
    patch: finish(
      [
        n(keysId, 'keyboard'),
        ...spec.nodes,
        ...modNodes,
        n('lvl', 'gain', { gain: spec.level }),
        n('lim', 'limiter', { threshold: 0.6, attack: 0.002, release: 0.08 }),
        n(masterId, 'master'),
      ],
      cables,
    ),
  };
}

function fx(
  id: string,
  name: string,
  category: string,
  blurb: string,
  spec: {
    nodes: PatchNode[];
    path: string[];
    level: number;
    mods?: Mod[];
    wires?: PatchConnection[];
  },
): FactoryPatch {
  const { nodes: modNodes, wires: modWires } = expand(spec.mods ?? [], kindMap(spec.nodes));
  const path = [...spec.path, 'lvl'];
  const cables = series([lineId, ...path]);
  const last = path[path.length - 1];
  if (last) cables.push(w(last, 'audio', masterId, 'input'));
  cables.push(...modWires, ...(spec.wires ?? []));
  return {
    id,
    name,
    category,
    blurb,
    slot: 'effect',
    patch: finish(
      [n(lineId, 'line'), ...spec.nodes, ...modNodes, n('lvl', 'gain', { gain: spec.level }), n(masterId, 'master')],
      cables,
    ),
  };
}

function selfPlaying(
  id: string,
  name: string,
  blurb: string,
  spec: {
    nodes: PatchNode[];
    path: string[];
    level: number;
    opens?: string[];
    resets?: string[];
    mods?: Mod[];
    wires?: PatchConnection[];
  },
): FactoryPatch {
  const { nodes: modNodes, wires: modWires } = expand(spec.mods ?? [], kindMap(spec.nodes));
  const path = [...spec.path, 'lvl', 'lim'];
  const cables = series(path);
  cables.push(...(spec.opens ?? []).map((voice) => w('open', 'audio', voice, 'velocity')));
  const last = path[path.length - 1];
  if (last) cables.push(w(last, 'audio', masterId, 'input'));
  cables.push(...(spec.resets ?? []).map((target) => w(songId, 'playing', target, 'reset')));
  cables.push(...modWires, ...(spec.wires ?? []));
  return {
    id,
    name,
    category: 'Plays Itself',
    blurb,
    slot: 'either',
    patch: finish(
      [
        n(songId, 'transport'),
        ...spec.nodes,
        ...modNodes,
        ...(spec.opens?.length ? [n('open', 'control', { value: 1 })] : []),
        n('lvl', 'gain', { gain: spec.level }),
        n('lim', 'limiter', { threshold: 0.7, attack: 0.002, release: 0.08 }),
        n(masterId, 'master'),
      ],
      cables,
    ),
  };
}

const bass: FactoryPatch[] = [
  inst('deep-sub', 'Deep Sub', 'Bass',
    'A sine two octaves down with everything above it filtered away. The note you feel rather than hear.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.sine, octave: -2, gain: 0.44, attack: 0.004, decay: 0.3, sustain: 0.95, release: 0.18 }),
        n('lp', 'lowpass', { cutoff: 420, q: 0.707 }),
      ],
      voices: ['osc'],
      path: ['osc', 'lp'],
      level: 0.9,
    }),
  inst('round-bass', 'Round Bass', 'Bass',
    'A sine sub with a triangle an octave above it, so the line still reads on a phone speaker.',
    {
      nodes: [
        n('sub', 'oscillator', { type: Wave.sine, octave: -2, gain: 0.28, attack: 0.004, decay: 0.3, sustain: 0.9, release: 0.2 }),
        n('body', 'oscillator', { type: Wave.triangle, octave: -1, gain: 0.15, attack: 0.004, decay: 0.25, sustain: 0.7, release: 0.18 }),
        n('lp', 'lowpass', { cutoff: 900, q: 0.8 }),
      ],
      voices: ['sub', 'body'],
      path: ['sub', 'lp'],
      level: 1.0,
      wires: [w('body', 'audio', 'lp', 'input')],
    }),
  inst('acid-line', 'Acid Line', 'Bass',
    'Synth Voice with its filter envelope wide open, into a ladder for the squelch. Turn the ladder\'s resonance up.',
    {
      nodes: [
        n('v', 'SynthVoice', { type: Wave.saw, octave: -1, cutoff: 320, resonance: 6, envAmt: 1.6, attack: 0.002, decay: 0.22, sustain: 0.05, release: 0.12, gain: 0.33 }),
        n('lad', 'ladder', { cutoff: 900, resonance: 0.78, drive: 2.4 }),
      ],
      voices: ['v'],
      path: ['v', 'lad'],
      level: 0.65,
    }),
  inst('rubber-pluck', 'Rubber Pluck', 'Bass',
    'Short square with a resonant lowpass and a little clip on the way out. Bouncy rather than heavy.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.square, octave: -1, gain: 0.2, attack: 0.002, decay: 0.16, sustain: 0.12, release: 0.12 }),
        n('lp', 'lowpass', { cutoff: 700, q: 2.2 }),
        n('sat', 'softclip', { drive: 2.4 }),
      ],
      voices: ['osc'],
      path: ['osc', 'lp', 'sat'],
      level: 0.55,
    }),
  inst('reese', 'Reese', 'Bass',
    'Two saws a few cents apart, beating against each other. The detune is the whole sound.',
    {
      nodes: [
        n('a', 'oscillator', { type: Wave.saw, octave: -1, detune: -13, gain: 0.15, attack: 0.01, decay: 0.3, sustain: 0.9, release: 0.25 }),
        n('b', 'oscillator', { type: Wave.saw, octave: -1, detune: 13, gain: 0.15, attack: 0.01, decay: 0.3, sustain: 0.9, release: 0.25 }),
        n('lp', 'lowpass', { cutoff: 820, q: 1.4 }),
        n('sat', 'softclip', { drive: 1.8 }),
      ],
      voices: ['a', 'b'],
      path: ['a', 'lp', 'sat'],
      level: 0.62,
      wires: [w('b', 'audio', 'lp', 'input')],
    }),
  inst('growl-bass', 'Growl Bass', 'Bass',
    'A saw ring modulated against a fixed low tone, then driven through a ladder. Metallic and rude.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.saw, octave: -1, gain: 0.36, attack: 0.006, decay: 0.25, sustain: 0.85, release: 0.18 }),
        n('rm', 'ringmod', { freq: 92, mix: 0.38 }),
        n('lad', 'ladder', { cutoff: 700, resonance: 0.55, drive: 3 }),
      ],
      voices: ['osc'],
      path: ['osc', 'rm', 'lad'],
      level: 0.75,
    }),
  inst('wobble-bass', 'Wobble Bass', 'Bass',
    'An LFO on the ladder\'s cutoff, trimmed to 220 Hz to 2.6 kHz. Change the LFO rate and nothing else.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.saw, octave: -1, gain: 0.4, attack: 0.004, decay: 0.3, sustain: 0.95, release: 0.15 }),
        n('lfo', 'lfo', { type: Wave.triangle, rate: 4.8, amount: 1 }),
        n('lad', 'ladder', { cutoff: 800, resonance: 0.72, drive: 2 }),
      ],
      voices: ['osc'],
      path: ['osc', 'lad'],
      level: 0.9,
      mods: [mod('wob', 'lfo', 'cv', 'lad', 'cutoff', 220, 2600)],
    }),
  inst('sub-and-click', 'Sub and Click', 'Bass',
    'A sine sub with a filtered noise transient on top, the noise opened by its own fast envelope.',
    {
      nodes: [
        n('sub', 'oscillator', { type: Wave.sine, octave: -2, gain: 0.26, attack: 0.003, decay: 0.3, sustain: 0.9, release: 0.16 }),
        n('env', 'adsr', { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05, amount: 1 }),
        n('nz', 'noise', { color: Noise.white, gain: 1, cutoff: 9000 }),
        vca('nvca'),
        n('hp', 'highpass', { cutoff: 1400, q: 0.8 }),
      ],
      voices: ['sub'],
      gates: ['env'],
      path: ['sub'],
      level: 1.0,
      mods: [mod('clk', 'env', 'cv', 'nvca', 'gain', 0, 0.2)],
      wires: [w('nz', 'audio', 'nvca', 'input'), w('nvca', 'audio', 'hp', 'input'), w('hp', 'audio', 'lvl', 'input')],
    }),
];

const lead: FactoryPatch[] = [
  inst('square-lead', 'Square Lead', 'Lead',
    'A plain square through a lowpass and a short delay. The lead every other lead is a variation on.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.square, gain: 0.34, attack: 0.004, decay: 0.12, sustain: 0.75, release: 0.14 }),
        n('lp', 'lowpass', { cutoff: 3200, q: 1.1 }),
        n('dly', 'delay', { timeSec: 0.28, feedback: 0.28, mix: 0.22 }),
      ],
      voices: ['osc'],
      path: ['osc', 'lp', 'dly'],
      level: 0.95,
    }),
  inst('dotted-saw', 'Dotted Saw', 'Lead',
    'Saw into a dotted eighth that locks to the host tempo. Play quarter notes and it fills itself in.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.saw, gain: 0.36, attack: 0.004, decay: 0.18, sustain: 0.7, release: 0.2 }),
        n('lp', 'lowpass', { cutoff: 4200, q: 0.9 }),
        n('dly', 'synceddelay', { division: Div.dottedEighth, feedback: 0.36, mix: 0.3 }),
      ],
      voices: ['osc'],
      path: ['osc', 'lp', 'dly'],
      level: 1.0,
    }),
  inst('super-saw', 'Super Saw', 'Lead',
    'Synth Voice with unison most of the way up. Wide, and thin in the middle on purpose, so a bass fits under it.',
    {
      nodes: [
        n('v', 'SynthVoice', { type: Wave.saw, unison: 0.85, detune: 18, cutoff: 6000, resonance: 0.7, envAmt: 0.5, attack: 0.01, decay: 0.5, sustain: 0.8, release: 0.5, gain: 0.14 }),
        n('hp', 'highpass', { cutoff: 140, q: 0.707 }),
      ],
      voices: ['v'],
      path: ['v', 'hp'],
      level: 0.8,
    }),
  inst('hollow-pulse', 'Hollow Pulse', 'Lead',
    'A narrow pulse with a slow LFO on its width. The classic hollow-to-full sweep, and it is one cable.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.pulse, width: 0.18, gain: 0.3, attack: 0.006, decay: 0.2, sustain: 0.8, release: 0.25 }),
        n('lfo', 'lfo', { type: Wave.sine, rate: 0.35, amount: 1 }),
        n('lp', 'lowpass', { cutoff: 4800, q: 0.9 }),
      ],
      voices: ['osc'],
      path: ['osc', 'lp'],
      level: 0.9,
      mods: [mod('pwm', 'lfo', 'cv', 'osc', 'width', 0.08, 0.5)],
    }),
  inst('ring-lead', 'Ring Lead', 'Lead',
    'A triangle multiplied by a fixed 330 Hz tone. Inharmonic, and it changes character across the keyboard.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.triangle, gain: 0.4, attack: 0.004, decay: 0.2, sustain: 0.7, release: 0.2 }),
        n('rm', 'ringmod', { freq: 330, mix: 0.5 }),
        n('lp', 'lowpass', { cutoff: 5200, q: 0.9 }),
      ],
      voices: ['osc'],
      path: ['osc', 'rm', 'lp'],
      level: 1.0,
    }),
  inst('octave-lead', 'Octave Lead', 'Lead',
    'Two squares an octave apart, the upper one quiet. Doubles a melody without anybody playing two parts.',
    {
      nodes: [
        n('low', 'oscillator', { type: Wave.square, gain: 0.22, attack: 0.004, decay: 0.16, sustain: 0.75, release: 0.16 }),
        n('high', 'oscillator', { type: Wave.square, octave: 1, gain: 0.1, attack: 0.004, decay: 0.16, sustain: 0.6, release: 0.16 }),
        n('lp', 'lowpass', { cutoff: 5000, q: 0.9 }),
      ],
      voices: ['low', 'high'],
      path: ['low', 'lp'],
      level: 0.85,
      wires: [w('high', 'audio', 'lp', 'input')],
    }),
  inst('chorused-lead', 'Chorused Lead', 'Lead',
    'A short modulated delay mixed half in, which is all a chorus is. The LFO is on the delay time.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.varShape, width: 0.4, gain: 0.38, attack: 0.008, decay: 0.25, sustain: 0.8, release: 0.3 }),
        n('lfo', 'lfo', { type: Wave.sine, rate: 0.8, amount: 1 }),
        n('cho', 'delay', { timeSec: 0.02, feedback: 0.1, mix: 0.45 }),
        n('lp', 'lowpass', { cutoff: 6000, q: 0.8 }),
      ],
      voices: ['osc'],
      path: ['osc', 'cho', 'lp'],
      level: 1.0,
      mods: [mod('vib', 'lfo', 'cv', 'cho', 'timeSec', 0.012, 0.028)],
    }),
  inst('gritty-lead', 'Gritty Lead', 'Lead',
    'Saw into a wavefolder at two thirds wet. Folding adds harmonics a filter cannot put back.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.saw, gain: 0.16, attack: 0.004, decay: 0.2, sustain: 0.75, release: 0.2 }),
        n('fold', 'waveshape', { curve: Curve.fold, drive: 3, mix: 0.65 }),
        n('lp', 'lowpass', { cutoff: 3600, q: 1.2 }),
      ],
      voices: ['osc'],
      path: ['osc', 'fold', 'lp'],
      level: 0.45,
    }),
];

const pad: FactoryPatch[] = [
  inst('warm-pad', 'Warm Pad', 'Pad',
    'Slow saw, filter well down, reverb behind it. The bed everything else sits on.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.saw, gain: 0.26, attack: 0.6, decay: 1.2, sustain: 0.8, release: 1.4 }),
        n('lp', 'lowpass', { cutoff: 2200, q: 0.7 }),
        n('rev', 'reverb', { size: 1.1, decay: 0.8, damp: 4000, mix: 0.35 }),
      ],
      voices: ['osc'],
      path: ['osc', 'lp', 'rev'],
      level: 1.5,
    }),
  inst('glass-pad', 'Glass Pad', 'Pad',
    'A wavetable with the low end taken out and a long delay after it. Bright without being sharp.',
    {
      nodes: [
        n('wt', 'wavetable', { position: 0.62, gain: 0.3, attack: 0.8, decay: 1, sustain: 0.7, release: 1.8 }),
        n('hp', 'highpass', { cutoff: 320, q: 0.707 }),
        n('dly', 'synceddelay', { division: Div.dottedQuarter, feedback: 0.35, mix: 0.28 }),
      ],
      voices: ['wt'],
      path: ['wt', 'hp', 'dly'],
      level: 1.0,
    }),
  inst('breathing-pad', 'Breathing Pad', 'Pad',
    'One slow LFO on the filter, trimmed to 500 Hz to 4 kHz. Nothing else moves, and that is the point.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.saw, gain: 0.26, attack: 0.5, decay: 1, sustain: 0.85, release: 1.6 }),
        n('lfo', 'lfo', { type: Wave.sine, rate: 0.12, amount: 1 }),
        n('svf', 'svflowpass', { cutoff: 2000, q: 2.2 }),
      ],
      voices: ['osc'],
      path: ['osc', 'svf'],
      level: 1.0,
      mods: [mod('br', 'lfo', 'cv', 'svf', 'cutoff', 500, 4200)],
    }),
  inst('string-machine', 'String Machine', 'Pad',
    'Two detuned saws through a chorus, which is a twenty millisecond delay with an LFO on its time.',
    {
      nodes: [
        n('a', 'oscillator', { type: Wave.saw, detune: -8, gain: 0.16, attack: 0.35, decay: 0.8, sustain: 0.85, release: 1 }),
        n('b', 'oscillator', { type: Wave.saw, detune: 8, gain: 0.16, attack: 0.4, decay: 0.8, sustain: 0.85, release: 1.1 }),
        n('lfo', 'lfo', { type: Wave.sine, rate: 0.6, amount: 1 }),
        n('cho', 'delay', { timeSec: 0.02, feedback: 0.12, mix: 0.5 }),
        n('lp', 'lowpass', { cutoff: 5200, q: 0.7 }),
      ],
      voices: ['a', 'b'],
      path: ['a', 'cho', 'lp'],
      level: 1.3,
      mods: [mod('cm', 'lfo', 'cv', 'cho', 'timeSec', 0.014, 0.026)],
      wires: [w('b', 'audio', 'cho', 'input')],
    }),
  inst('choir-pad', 'Choir Pad', 'Pad',
    'A harmonic oscillator through two narrow bandpasses at 700 and 1900 Hz. Two fixed formants, and it reads as a voice.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.harmonic, gain: 0.3, attack: 0.45, decay: 0.9, sustain: 0.8, release: 1.2 }),
        n('f1', 'bandpass', { cutoff: 520, q: 2.6 }),
        n('f2', 'bandpass', { cutoff: 1500, q: 3 }),
        n('rev', 'reverb', { size: 1.2, decay: 0.82, damp: 5200, mix: 0.32 }),
      ],
      voices: ['osc'],
      path: ['osc', 'f1', 'rev'],
      level: 2.6,
      wires: [w('osc', 'audio', 'f2', 'input'), w('f2', 'audio', 'rev', 'input')],
    }),
  inst('dark-drone', 'Dark Drone', 'Pad',
    'A triangle an octave down with a sine under it, filtered to almost nothing and left to ring.',
    {
      nodes: [
        n('body', 'oscillator', { type: Wave.triangle, octave: -1, gain: 0.28, attack: 0.9, decay: 1.5, sustain: 0.9, release: 2 }),
        n('sub', 'oscillator', { type: Wave.sine, octave: -2, gain: 0.2, attack: 1.2, decay: 1.5, sustain: 0.9, release: 2.4 }),
        n('lp', 'lowpass', { cutoff: 900, q: 0.9 }),
        n('rev', 'reverb', { size: 1.35, decay: 0.88, damp: 2200, mix: 0.5 }),
      ],
      voices: ['body', 'sub'],
      path: ['body', 'lp', 'rev'],
      level: 1.8,
      wires: [w('sub', 'audio', 'lp', 'input')],
    }),
  inst('shimmer-pad', 'Shimmer Pad', 'Pad',
    'The dry pad and a copy of it an octave up both feed the reverb. The octave never reaches the output on its own.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.saw, gain: 0.24, attack: 0.7, decay: 1.2, sustain: 0.8, release: 1.8 }),
        n('lp', 'lowpass', { cutoff: 3000, q: 0.7 }),
        n('oct', 'pitchshift', { pitch: 12, mix: 1 }),
        n('rev', 'reverb', { size: 1.3, decay: 0.86, damp: 6000, mix: 0.45 }),
      ],
      voices: ['osc'],
      path: ['osc', 'lp', 'rev'],
      level: 1.15,
      wires: [w('lp', 'audio', 'oct', 'input'), w('oct', 'audio', 'rev', 'input')],
    }),
  inst('slow-swell', 'Slow Swell', 'Pad',
    'Almost two seconds of attack and four of release. Hold a chord, let go, and it is still going.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.saw, gain: 0.3, attack: 1.8, decay: 2, sustain: 1, release: 3.5 }),
        n('lp', 'lowpass', { cutoff: 2600, q: 0.8 }),
        n('rev', 'reverb', { size: 1.4, decay: 0.9, damp: 3600, mix: 0.55 }),
      ],
      voices: ['osc'],
      path: ['osc', 'lp', 'rev'],
      level: 1.6,
    }),
];

const keys: FactoryPatch[] = [
  inst('electric-piano', 'Electric Piano', 'Keys & Pluck',
    'A sine with a quiet triangle an octave up, and a tempo locked tremolo on the end.',
    {
      nodes: [
        n('body', 'oscillator', { type: Wave.sine, gain: 0.34, attack: 0.002, decay: 0.9, sustain: 0.25, release: 0.5 }),
        n('tine', 'oscillator', { type: Wave.triangle, octave: 1, gain: 0.14, attack: 0.002, decay: 0.35, sustain: 0.1, release: 0.3 }),
        n('lp', 'lowpass', { cutoff: 3800, q: 0.8 }),
        n('trem', 'syncedtremolo', { division: Div.quarter, depth: 0.35 }),
      ],
      voices: ['body', 'tine'],
      path: ['body', 'lp', 'trem'],
      level: 1.0,
      wires: [w('tine', 'audio', 'lp', 'input')],
    }),
  inst('bell', 'Bell', 'Keys & Pluck',
    'A harmonic oscillator ring modulated against 720 Hz. Inharmonic partials are what make a bell a bell.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.harmonic, gain: 0.45, attack: 0.001, decay: 1.4, sustain: 0, release: 1.2 }),
        n('rm', 'ringmod', { freq: 720, mix: 0.45 }),
        n('rev', 'reverb', { size: 1.2, decay: 0.84, damp: 6500, mix: 0.35 }),
      ],
      voices: ['osc'],
      path: ['osc', 'rm', 'rev'],
      level: 2.2,
    }),
  inst('marimba', 'Marimba', 'Keys & Pluck',
    'A short sine with a shorter sine an octave above it. Wooden because the top one dies first.',
    {
      nodes: [
        n('body', 'oscillator', { type: Wave.sine, gain: 0.4, attack: 0.002, decay: 0.32, sustain: 0, release: 0.25 }),
        n('tap', 'oscillator', { type: Wave.sine, octave: 1, gain: 0.11, attack: 0.001, decay: 0.12, sustain: 0, release: 0.1 }),
        n('lp', 'lowpass', { cutoff: 4200, q: 0.8 }),
      ],
      voices: ['body', 'tap'],
      path: ['body', 'lp'],
      level: 1.0,
      wires: [w('tap', 'audio', 'lp', 'input')],
    }),
  inst('nylon-pluck', 'Nylon Pluck', 'Keys & Pluck',
    'A variable shape oscillator with a soft filter and a small room. Close to a nylon string if you play it gently.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.varShape, width: 0.3, gain: 0.34, attack: 0.002, decay: 0.5, sustain: 0.15, release: 0.4 }),
        n('lp', 'lowpass', { cutoff: 2600, q: 1.3 }),
        n('rev', 'reverb', { size: 0.7, decay: 0.55, damp: 5000, mix: 0.22 }),
      ],
      voices: ['osc'],
      path: ['osc', 'lp', 'rev'],
      level: 1.0,
    }),
  inst('clav', 'Clav', 'Keys & Pluck',
    'A narrow pulse through a resonant bandpass and a little clip. All attack, no tail.',
    {
      nodes: [
        n('osc', 'oscillator', { type: Wave.pulse, width: 0.2, gain: 0.3, attack: 0.001, decay: 0.18, sustain: 0.18, release: 0.12 }),
        n('bp', 'bandpass', { cutoff: 1800, q: 2.2 }),
        n('sat', 'softclip', { drive: 2 }),
      ],
      voices: ['osc'],
      path: ['osc', 'bp', 'sat'],
      level: 0.8,
    }),
  inst('music-box', 'Music Box', 'Keys & Pluck',
    'Two sines two octaves apart, both decaying to nothing, in a fairly wet room.',
    {
      nodes: [
        n('body', 'oscillator', { type: Wave.sine, gain: 0.34, attack: 0.001, decay: 0.7, sustain: 0, release: 0.6 }),
        n('ting', 'oscillator', { type: Wave.sine, octave: 2, gain: 0.1, attack: 0.001, decay: 0.25, sustain: 0, release: 0.2 }),
        n('rev', 'reverb', { size: 1.15, decay: 0.8, damp: 7000, mix: 0.42 }),
      ],
      voices: ['body', 'ting'],
      path: ['body', 'rev'],
      level: 1.0,
      wires: [w('ting', 'audio', 'rev', 'input')],
    }),
  inst('harpsichord', 'Harpsichord', 'Keys & Pluck',
    'Saw plus a square an octave up, the bottom filtered off. Thin on purpose.',
    {
      nodes: [
        n('low', 'oscillator', { type: Wave.saw, gain: 0.26, attack: 0.001, decay: 0.5, sustain: 0.08, release: 0.25 }),
        n('high', 'oscillator', { type: Wave.square, octave: 1, gain: 0.14, attack: 0.001, decay: 0.4, sustain: 0.05, release: 0.2 }),
        n('hp', 'highpass', { cutoff: 240, q: 0.707 }),
        n('lp', 'lowpass', { cutoff: 6500, q: 0.8 }),
      ],
      voices: ['low', 'high'],
      path: ['low', 'hp', 'lp'],
      level: 1.0,
      wires: [w('high', 'audio', 'hp', 'input')],
    }),
  inst('toy-piano', 'Toy Piano', 'Keys & Pluck',
    'Triangle and square, both an octave or two up, squeezed through a bandpass. Small and slightly wrong.',
    {
      nodes: [
        n('body', 'oscillator', { type: Wave.triangle, octave: 1, gain: 0.32, attack: 0.001, decay: 0.35, sustain: 0.05, release: 0.3 }),
        n('tick', 'oscillator', { type: Wave.square, octave: 2, gain: 0.08, attack: 0.001, decay: 0.1, sustain: 0, release: 0.08 }),
        n('bp', 'bandpass', { cutoff: 1200, q: 1.1 }),
      ],
      voices: ['body', 'tick'],
      path: ['body', 'bp'],
      level: 1.4,
      wires: [w('tick', 'audio', 'bp', 'input')],
    }),
];

const percussion: FactoryPatch[] = [
  inst('kick', 'Kick', 'Percussion',
    'A sine body two octaves down, a short triangle for the knock, and a higher triangle for the beater. Play the note that matches the kit.',
    {
      nodes: [
        n('body', 'oscillator', { type: Wave.sine, octave: -2, gain: 0.46, attack: 0.001, decay: 0.26, sustain: 0, release: 0.14 }),
        n('knock', 'oscillator', { type: Wave.triangle, octave: -1, gain: 0.889, attack: 0.001, decay: 0.115, sustain: 0, release: 0.07 }),
        n('beater', 'oscillator', { type: Wave.triangle, octave: 2, gain: 0.08, attack: 0.001, decay: 0.016, sustain: 0, release: 0.01 }),
        n('hp', 'highpass', { cutoff: 38, q: 0.65 }),
        n('sat', 'softclip', { drive: 1.28 }),
      ],
      voices: ['body', 'knock', 'beater'],
      path: ['body', 'hp', 'sat'],
      level: 0.62,
      wires: [
        w('knock', 'audio', 'hp', 'input'),
        w('beater', 'audio', 'lvl', 'input'),
      ],
    }),
  inst('snare', 'Snare', 'Percussion',
    'Filtered noise for the wires and a 190 Hz tone for the drum, each with its own envelope.',
    {
      nodes: [
        n('env', 'adsr', { attack: 0.001, decay: 0.14, sustain: 0, release: 0.09, amount: 1 }),
        n('body', 'adsr', { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05, amount: 1 }),
        n('nz', 'noise', { color: Noise.white, gain: 1, cutoff: 11000 }),
        vca('nvca'),
        n('bp', 'bandpass', { cutoff: 1900, q: 1.2 }),
        n('tn', 'tone', { freq: 190, gain: 1 }),
        vca('tvca'),
      ],
      gates: ['env', 'body'],
      path: ['nz', 'nvca', 'bp'],
      level: 0.48,
      mods: [
        mod('sn', 'env', 'cv', 'nvca', 'gain', 0, 0.36),
        mod('sb', 'body', 'cv', 'tvca', 'gain', 0, 0.26),
      ],
      wires: [w('tn', 'audio', 'tvca', 'input'), w('tvca', 'audio', 'lvl', 'input')],
    }),
  inst('hi-hat', 'Hi-Hat', 'Percussion',
    'White noise above 8 kHz with a closed-hat envelope. Lengthen the decay and it is an open hat.',
    {
      nodes: [
        n('env', 'adsr', { attack: 0.001, decay: 0.026, sustain: 0, release: 0.014, amount: 1 }),
        n('nz', 'noise', { color: Noise.white, gain: 1, cutoff: 14000 }),
        vca('vca'),
        n('hp', 'highpass', { cutoff: 8200, q: 0.85 }),
      ],
      gates: ['env'],
      path: ['nz', 'vca', 'hp'],
      level: 0.48,
      mods: [mod('hh', 'env', 'cv', 'vca', 'gain', 0, 0.26)],
    }),
  inst('tom', 'Tom', 'Percussion',
    'The kick\'s three voices, one octave up and held longer. Knock is the skin. Play the note that matches the drum.',
    {
      nodes: [
        n('body', 'oscillator', { type: Wave.sine, octave: -1, gain: 0.4, attack: 0.002, decay: 0.55, sustain: 0, release: 0.38 }),
        n('knock', 'oscillator', { type: Wave.triangle, octave: 0, gain: 0.78, attack: 0.001, decay: 0.22, sustain: 0, release: 0.14 }),
        n('stick', 'oscillator', { type: Wave.triangle, octave: 2, gain: 0.07, attack: 0.001, decay: 0.02, sustain: 0, release: 0.012 }),
        n('hp', 'highpass', { cutoff: 70, q: 0.7 }),
        n('lp', 'lowpass', { cutoff: 4200, q: 0.75 }),
        n('sat', 'softclip', { drive: 1.18 }),
      ],
      voices: ['body', 'knock', 'stick'],
      path: ['body', 'hp', 'lp', 'sat'],
      level: 0.58,
      wires: [
        w('knock', 'audio', 'hp', 'input'),
        w('stick', 'audio', 'lvl', 'input'),
      ],
    }),
  inst('clap', 'Clap', 'Percussion',
    'Noise through a wide bandpass with a slower decay than a hat, and a small room to smear it.',
    {
      nodes: [
        n('env', 'adsr', { attack: 0.002, decay: 0.14, sustain: 0, release: 0.1, amount: 1 }),
        n('nz', 'noise', { color: Noise.white, gain: 1, cutoff: 9000 }),
        vca('vca'),
        n('bp', 'bandpass', { cutoff: 1400, q: 1.8 }),
        n('rev', 'reverb', { size: 0.6, decay: 0.42, damp: 5000, mix: 0.3 }),
      ],
      gates: ['env'],
      path: ['nz', 'vca', 'bp', 'rev'],
      level: 2.4,
      mods: [mod('cl', 'env', 'cv', 'vca', 'gain', 0, 0.5)],
    }),
  inst('rimshot', 'Rimshot', 'Percussion',
    'A very narrow bandpass on noise plus a 400 Hz click. Almost no decay at all.',
    {
      nodes: [
        n('env', 'adsr', { attack: 0.001, decay: 0.035, sustain: 0, release: 0.03, amount: 1 }),
        n('nz', 'noise', { color: Noise.white, gain: 1, cutoff: 14000 }),
        vca('nvca'),
        n('bp', 'bandpass', { cutoff: 2600, q: 6 }),
        n('tn', 'tone', { freq: 400, gain: 1 }),
        vca('tvca'),
      ],
      gates: ['env'],
      path: ['nz', 'nvca', 'bp'],
      level: 0.9,
      mods: [
        mod('rs', 'env', 'cv', 'nvca', 'gain', 0, 0.4),
        mod('rc', 'env', 'cv', 'tvca', 'gain', 0, 0.25),
      ],
      wires: [w('tn', 'audio', 'tvca', 'input'), w('tvca', 'audio', 'lvl', 'input')],
    }),
];

const filterAndTone: FactoryPatch[] = [
  fx('telephone', 'Telephone', 'Filter & Tone',
    'Everything outside 400 Hz to 2.6 kHz taken away, with a little clip for the cheap speaker.',
    {
      nodes: [
        n('hp', 'highpass', { cutoff: 400, q: 0.9 }),
        n('bp', 'bandpass', { cutoff: 1400, q: 1.6 }),
        n('lp', 'lowpass', { cutoff: 2600, q: 0.8 }),
        n('sat', 'softclip', { drive: 1.6 }),
      ],
      path: ['hp', 'bp', 'lp', 'sat'],
      level: 1.2,
    }),
  fx('lofi-radio', 'Lo-fi Radio', 'Filter & Tone',
    'A band around the middle, then asymmetric shaping. Thin and slightly broken, which is the whole idea.',
    {
      nodes: [
        n('hp', 'highpass', { cutoff: 300, q: 0.8 }),
        n('lp', 'lowpass', { cutoff: 3400, q: 0.9 }),
        n('shp', 'waveshape', { curve: Curve.asym, drive: 2, mix: 0.6 }),
      ],
      path: ['hp', 'lp', 'shp'],
      level: 0.9,
    }),
  fx('tilt-eq', 'Tilt EQ', 'Filter & Tone',
    'A shelf up at the bottom and the same shelf down at the top. One move, two bands, and it stays balanced.',
    {
      nodes: [
        n('low', 'lowshelf', { freq: 300, gainDb: 4, q: 0.707 }),
        n('high', 'highshelf', { freq: 3000, gainDb: -4, q: 0.707 }),
      ],
      path: ['low', 'high'],
      level: 1,
    }),
  fx('auto-wah', 'Auto Wah', 'Filter & Tone',
    'An envelope follower on the ladder\'s cutoff, so the filter opens as hard as you play. Trimmed to 300 Hz to 3.2 kHz.',
    {
      nodes: [
        n('fol', 'envfollow', { attack: 0.008, release: 0.18 }),
        n('lad', 'ladder', { cutoff: 800, resonance: 0.6, drive: 1.4 }),
      ],
      path: ['lad'],
      level: 1,
      mods: [mod('wah', 'fol', 'cv', 'lad', 'cutoff', 300, 3200)],
      wires: [w(lineId, 'audio', 'fol', 'input')],
    }),
  fx('filter-sweep', 'Filter Sweep', 'Filter & Tone',
    'A five second LFO on a state variable filter. Slow enough to be a build rather than a wobble.',
    {
      nodes: [
        n('lfo', 'lfo', { type: Wave.sine, rate: 0.2, amount: 1 }),
        n('svf', 'svflowpass', { cutoff: 1200, q: 2.5 }),
      ],
      path: ['svf'],
      level: 1,
      mods: [mod('sw', 'lfo', 'cv', 'svf', 'cutoff', 200, 6000)],
    }),
  fx('sub-boost', 'Sub Boost', 'Filter & Tone',
    'Six decibels under 90 Hz with a limiter behind it, because that is six decibels of headroom gone.',
    {
      nodes: [
        n('shelf', 'lowshelf', { freq: 90, gainDb: 6, q: 0.707 }),
        n('lim', 'limiter', { threshold: 0.8, attack: 0.002, release: 0.06 }),
      ],
      path: ['shelf', 'lim'],
      level: 1,
    }),
  fx('air-lift', 'Air Lift', 'Filter & Tone',
    'A wide shelf at 9 kHz and a small cut at 250, which is the oldest trick for making something sound expensive.',
    {
      nodes: [
        n('mud', 'lowshelf', { freq: 250, gainDb: -3, q: 0.707 }),
        n('air', 'highshelf', { freq: 9000, gainDb: 5, q: 0.707 }),
      ],
      path: ['mud', 'air'],
      level: 1,
    }),
  fx('formant', 'Formant', 'Filter & Tone',
    'Two narrow bandpasses in parallel at 700 and 1150 Hz, summed. Those two numbers are roughly where a spoken vowel sits.',
    {
      nodes: [
        n('f1', 'bandpass', { cutoff: 700, q: 4 }),
        n('f2', 'bandpass', { cutoff: 1150, q: 5 }),
      ],
      path: ['f1'],
      level: 2.2,
      wires: [w(lineId, 'audio', 'f2', 'input'), w('f2', 'audio', 'lvl', 'input')],
    }),
];

const driveAndCrush: FactoryPatch[] = [
  fx('warm-saturation', 'Warm Saturation', 'Drive & Crush',
    'Asymmetric shaping at four fifths wet, then a shelf to put the weight back. Tape flattery, roughly.',
    {
      nodes: [
        n('shp', 'waveshape', { curve: Curve.asym, drive: 2.2, mix: 0.8 }),
        n('dc', 'dcblock'),
        n('body', 'lowshelf', { freq: 140, gainDb: 2, q: 0.707 }),
      ],
      path: ['shp', 'dc', 'body'],
      level: 0.8,
    }),
  fx('fuzz', 'Fuzz', 'Drive & Crush',
    'Hard clipping at eight times, with the top rolled off so it is rude rather than painful.',
    {
      nodes: [
        n('clip', 'hardclip', { drive: 8 }),
        n('lp', 'lowpass', { cutoff: 3200, q: 0.9 }),
      ],
      path: ['clip', 'lp'],
      level: 0.35,
    }),
  fx('bitcrusher', 'Bitcrusher', 'Drive & Crush',
    'Six bits, with a lowpass after it to take the worst of the aliasing off.',
    {
      nodes: [
        n('crush', 'bitcrush', { bits: 6 }),
        n('lp', 'lowpass', { cutoff: 6000, q: 0.8 }),
      ],
      path: ['crush', 'lp'],
      level: 0.9,
    }),
  fx('sample-rate-crush', 'Rate Crush', 'Drive & Crush',
    'Every eighth sample held. Different from bit crushing: this one takes the top away rather than the detail.',
    {
      nodes: [
        n('ds', 'downsample', { factor: 8 }),
        n('lp', 'lowpass', { cutoff: 7000, q: 0.8 }),
      ],
      path: ['ds', 'lp'],
      level: 0.9,
    }),
  fx('wavefolder', 'Wavefolder', 'Drive & Crush',
    'Folding rather than clipping, so it adds harmonics a filter cannot put back. Loud input folds more.',
    {
      nodes: [
        n('fold', 'waveshape', { curve: Curve.fold, drive: 5, mix: 1 }),
        n('dc', 'dcblock'),
        n('lp', 'lowpass', { cutoff: 5000, q: 0.9 }),
      ],
      path: ['fold', 'dc', 'lp'],
      level: 0.4,
    }),
  fx('tape-drive', 'Tape Drive', 'Drive & Crush',
    'Soft clip, bass shelf up, treble shelf down. Three moves, and together they are a tape machine.',
    {
      nodes: [
        n('sat', 'softclip', { drive: 2.2 }),
        n('low', 'lowshelf', { freq: 120, gainDb: 3, q: 0.707 }),
        n('high', 'highshelf', { freq: 9000, gainDb: -4, q: 0.707 }),
      ],
      path: ['sat', 'low', 'high'],
      level: 0.7,
    }),
  fx('octave-fuzz', 'Octave Fuzz', 'Drive & Crush',
    'Full rectification doubles the frequency before the clipping stage. The octave is free.',
    {
      nodes: [
        n('rect', 'fullrectify'),
        n('dc', 'dcblock'),
        n('clip', 'hardclip', { drive: 4 }),
        n('bp', 'bandpass', { cutoff: 1200, q: 1 }),
      ],
      path: ['rect', 'dc', 'clip', 'bp'],
      level: 0.6,
    }),
  fx('ring-mod-fx', 'Ring Mod', 'Drive & Crush',
    'Multiplied by a fixed 140 Hz. Not in key with anything, which is what it is for.',
    {
      nodes: [
        n('rm', 'ringmod', { freq: 140, mix: 0.5 }),
        n('lp', 'lowpass', { cutoff: 6000, q: 0.8 }),
      ],
      path: ['rm', 'lp'],
      level: 1,
    }),
];

const delay: FactoryPatch[] = [
  fx('slapback', 'Slapback', 'Delay',
    'One repeat at 110 milliseconds. Short enough to read as a room rather than an echo.',
    { nodes: [n('dly', 'delay', { timeSec: 0.11, feedback: 0.08, mix: 0.3 })], path: ['dly'], level: 1 }),
  fx('tape-echo', 'Tape Echo', 'Delay',
    'Quarter notes locked to the host, with the repeats filtered. Each one comes back darker than the last.',
    {
      nodes: [
        n('dly', 'synceddelay', { division: Div.quarter, feedback: 0.45, mix: 0.3 }),
        n('lp', 'lowpass', { cutoff: 3000, q: 0.8 }),
      ],
      path: ['dly', 'lp'],
      level: 1,
    }),
  fx('dotted-eighth', 'Dotted Eighth', 'Delay',
    'The delay that fills a bar without landing on the beat. Play quarter notes over it.',
    { nodes: [n('dly', 'synceddelay', { division: Div.dottedEighth, feedback: 0.38, mix: 0.32 })], path: ['dly'], level: 1 }),
  fx('dub-delay', 'Dub Delay', 'Delay',
    'High feedback with the repeats banded between 200 Hz and 1.8 kHz, so they decay into mud rather than into hiss.',
    {
      nodes: [
        n('dly', 'synceddelay', { division: Div.quarter, feedback: 0.72, mix: 0.4 }),
        n('lp', 'lowpass', { cutoff: 1800, q: 0.9 }),
        n('hp', 'highpass', { cutoff: 200, q: 0.8 }),
      ],
      path: ['dly', 'lp', 'hp'],
      level: 1,
    }),
  fx('reverse-delay', 'Reverse Delay', 'Delay',
    'Half second buffers played backwards, then delayed. Swells that arrive before the note does.',
    {
      nodes: [
        n('rev', 'reverse', { timeSec: 0.5 }),
        n('dly', 'delay', { timeSec: 0.25, feedback: 0.25, mix: 0.4 }),
      ],
      path: ['rev', 'dly'],
      level: 1,
    }),
  fx('octave-delay', 'Octave Delay', 'Delay',
    'The dry signal and a copy an octave down both go into the delay. Only the repeats are pitched.',
    {
      nodes: [
        n('oct', 'pitchshift', { pitch: -12, mix: 1 }),
        n('dly', 'delay', { timeSec: 0.3, feedback: 0.4, mix: 0.4 }),
      ],
      path: ['dly'],
      level: 1,
      wires: [w(lineId, 'audio', 'oct', 'input'), w('oct', 'audio', 'dly', 'input')],
    }),
  fx('stutter', 'Stutter', 'Delay',
    'A sixteenth note tremolo chopping the signal, then a sixteenth note delay catching the pieces.',
    {
      nodes: [
        n('chop', 'syncedtremolo', { division: Div.sixteenth, depth: 1 }),
        n('dly', 'synceddelay', { division: Div.sixteenth, feedback: 0.3, mix: 0.25 }),
      ],
      path: ['chop', 'dly'],
      level: 1.2,
    }),
  fx('triplet-echo', 'Triplet Echo', 'Delay',
    'Eighth note triplets. Against a straight part it is the cheapest way to make a bar feel busy.',
    { nodes: [n('dly', 'synceddelay', { division: Div.tripletEighth, feedback: 0.4, mix: 0.3 })], path: ['dly'], level: 1 }),
];

const reverbAndSpace: FactoryPatch[] = [
  fx('small-room', 'Small Room', 'Reverb & Space',
    'Barely there. Enough to stop something sounding like it was recorded in a box.',
    { nodes: [n('rev', 'reverb', { size: 0.5, decay: 0.4, damp: 6000, mix: 0.22 })], path: ['rev'], level: 1 }),
  fx('big-hall', 'Big Hall', 'Reverb & Space',
    'Long and dark. Put it after something that has already stopped playing.',
    { nodes: [n('rev', 'reverb', { size: 1.35, decay: 0.88, damp: 3200, mix: 0.45 })], path: ['rev'], level: 1 }),
  fx('plate', 'Plate', 'Reverb & Space',
    'Short, bright and dense, with a shelf on top. The reverb for a snare.',
    {
      nodes: [
        n('rev', 'reverb', { size: 0.8, decay: 0.7, damp: 9000, mix: 0.35 }),
        n('air', 'highshelf', { freq: 6000, gainDb: 3, q: 0.707 }),
      ],
      path: ['rev', 'air'],
      level: 1,
    }),
  fx('shimmer', 'Shimmer', 'Reverb & Space',
    'An octave up feeding the same reverb as the dry signal. The pitch shifter never reaches the output on its own.',
    {
      nodes: [
        n('oct', 'pitchshift', { pitch: 12, mix: 1 }),
        n('rev', 'reverb', { size: 1.3, decay: 0.87, damp: 6000, mix: 0.45 }),
      ],
      path: ['rev'],
      level: 1,
      wires: [w(lineId, 'audio', 'oct', 'input'), w('oct', 'audio', 'rev', 'input')],
    }),
  fx('gated-reverb', 'Gated Reverb', 'Reverb & Space',
    'A big reverb with a gate across it, so the tail stops dead. The sound of 1984, and it is two modules.',
    {
      nodes: [
        n('rev', 'reverb', { size: 0.9, decay: 0.62, damp: 5000, mix: 0.6 }),
        n('gate', 'gate', { threshold: 0.06, attack: 0.001, release: 0.03, hold: 0.08 }),
      ],
      path: ['rev', 'gate'],
      level: 1,
    }),
  fx('dark-cavern', 'Dark Cavern', 'Reverb & Space',
    'Damping right down and a lowpass after it. Nothing above 2 kHz survives the trip.',
    {
      nodes: [
        n('rev', 'reverb', { size: 1.4, decay: 0.9, damp: 1500, mix: 0.55 }),
        n('lp', 'lowpass', { cutoff: 2200, q: 0.8 }),
      ],
      path: ['rev', 'lp'],
      level: 1.2,
    }),
  fx('ambient-wash', 'Ambient Wash', 'Reverb & Space',
    'A half note delay into a long reverb. The order matters: reverb into delay is a different, muddier patch.',
    {
      nodes: [
        n('dly', 'synceddelay', { division: Div.half, feedback: 0.5, mix: 0.35 }),
        n('rev', 'reverb', { size: 1.3, decay: 0.88, damp: 3000, mix: 0.5 }),
      ],
      path: ['dly', 'rev'],
      level: 1,
    }),
];

const modulation: FactoryPatch[] = [
  fx('chorus', 'Chorus', 'Modulation',
    'A twenty millisecond delay with an LFO on its time, mixed half in. That is all a chorus has ever been.',
    {
      nodes: [
        n('lfo', 'lfo', { type: Wave.sine, rate: 0.7, amount: 1 }),
        n('cho', 'delay', { timeSec: 0.02, feedback: 0.1, mix: 0.45 }),
      ],
      path: ['cho'],
      level: 1,
      mods: [mod('cm', 'lfo', 'cv', 'cho', 'timeSec', 0.013, 0.027)],
    }),
  fx('flanger', 'Flanger', 'Modulation',
    'A comb filter with an LFO on its frequency and the feedback well up. Jet plane territory.',
    {
      nodes: [
        n('lfo', 'lfo', { type: Wave.triangle, rate: 0.25, amount: 1 }),
        n('comb', 'comb', { freq: 220, feedback: 0.7, mix: 0.5 }),
      ],
      path: ['comb'],
      level: 1,
      mods: [mod('fl', 'lfo', 'cv', 'comb', 'freq', 80, 900)],
    }),
  fx('phaser', 'Phaser', 'Modulation',
    'Two allpass stages swept by one LFO. Allpass changes phase and not level, which is why this sounds hollow rather than filtered.',
    {
      nodes: [
        n('lfo', 'lfo', { type: Wave.sine, rate: 0.4, amount: 1 }),
        n('ap1', 'allpass', { cutoff: 600, q: 0.9 }),
        n('ap2', 'allpass', { cutoff: 1400, q: 0.9 }),
      ],
      path: ['ap1', 'ap2'],
      level: 1,
      mods: [
        mod('p1', 'lfo', 'cv', 'ap1', 'cutoff', 300, 1600),
        mod('p2', 'lfo', 'cv', 'ap2', 'cutoff', 800, 3600),
      ],
    }),
  fx('tremolo', 'Tremolo', 'Modulation',
    'Eighth notes, locked to the host. Depth at 0.6 so it breathes rather than chops.',
    { nodes: [n('trem', 'syncedtremolo', { division: Div.eighth, depth: 0.6 })], path: ['trem'], level: 1 }),
  fx('auto-pan', 'Auto Pan', 'Modulation',
    'Side to side just under once a second. On headphones this is a lot; on speakers it is barely there.',
    { nodes: [n('pan', 'autopan', { rate: 0.8, depth: 0.8 })], path: ['pan'], level: 1 }),
  fx('vibrato', 'Vibrato', 'Modulation',
    'The chorus with no dry signal in it. An eight millisecond delay, fully wet, with the LFO on its time.',
    {
      nodes: [
        n('lfo', 'lfo', { type: Wave.sine, rate: 5, amount: 1 }),
        n('vib', 'delay', { timeSec: 0.008, feedback: 0, mix: 1 }),
      ],
      path: ['vib'],
      level: 1,
      mods: [mod('vm', 'lfo', 'cv', 'vib', 'timeSec', 0.005, 0.011)],
    }),
  fx('rotary', 'Rotary', 'Modulation',
    'Fast panning with the filter moving in step, because a rotating speaker gets darker as it turns away.',
    {
      nodes: [
        n('lfo', 'lfo', { type: Wave.sine, rate: 5.5, amount: 1 }),
        n('pan', 'autopan', { rate: 5.5, depth: 0.5 }),
        n('lp', 'lowpass', { cutoff: 3500, q: 0.8 }),
      ],
      path: ['pan', 'lp'],
      level: 1,
      mods: [mod('rt', 'lfo', 'cv', 'lp', 'cutoff', 1800, 6000)],
    }),
  fx('sample-hold-filter', 'Sample and Hold', 'Modulation',
    'A stepped random on the cutoff, seven steps a second. Held values, not a sweep, which is the difference that matters.',
    {
      nodes: [
        n('rnd', 'randomstepped', { freq: 7 }),
        n('lp', 'lowpass', { cutoff: 2000, q: 3 }),
      ],
      path: ['lp'],
      level: 1,
      mods: [mod('sh', 'rnd', 'audio', 'lp', 'cutoff', 400, 6000)],
    }),
];

const dynamics: FactoryPatch[] = [
  fx('vocal-comp', 'Vocal Comp', 'Dynamics',
    'Four to one with a fast attack and makeup to bring it back. The one that makes a take sit still.',
    {
      nodes: [n('comp', 'compressor', { threshold: 0.25, ratio: 4, attack: 0.006, release: 0.12, makeup: 1.8, mix: 1 })],
      path: ['comp'],
      level: 1,
    }),
  fx('drum-glue', 'Drum Glue', 'Dynamics',
    'Gentle ratio, slow attack so the transients get through, release timed to let it breathe between hits.',
    {
      nodes: [n('comp', 'compressor', { threshold: 0.4, ratio: 2.5, attack: 0.02, release: 0.18, makeup: 1.3, mix: 1 })],
      path: ['comp'],
      level: 1,
    }),
  fx('brickwall', 'Brickwall', 'Dynamics',
    'A ceiling and nothing else. Put it last, and if it is working hard, turn something else down.',
    { nodes: [n('lim', 'limiter', { threshold: 0.7, attack: 0.001, release: 0.05 })], path: ['lim'], level: 1 }),
  fx('noise-gate', 'Noise Gate', 'Dynamics',
    'Closes below three percent, with a hold so it does not chatter on a decaying note.',
    { nodes: [n('gate', 'gate', { threshold: 0.03, attack: 0.002, release: 0.08, hold: 0.02 })], path: ['gate'], level: 1 }),
  fx('punch', 'Punch', 'Dynamics',
    'Transient shaping: attack up, sustain down. It finds the hits by itself, so there is no threshold to set.',
    { nodes: [n('tr', 'transient', { attack: 0.6, sustain: -0.2 })], path: ['tr'], level: 1 }),
  fx('parallel-comp', 'Parallel Comp', 'Dynamics',
    'A heavily squashed copy summed back with the dry. Both cables land on the same inlet, which is how crate mixes.',
    {
      nodes: [
        n('comp', 'compressor', { threshold: 0.12, ratio: 12, attack: 0.003, release: 0.1, makeup: 2.2, mix: 1 }),
        n('sum', 'gain', { gain: 0.6 }),
      ],
      path: ['comp', 'sum'],
      level: 1,
      wires: [w(lineId, 'audio', 'sum', 'input')],
    }),
  fx('pump', 'Pump', 'Dynamics',
    'A quarter note clock, widened by a pulse, into the ducker\'s sidechain. Sidechain pumping with nothing to sidechain from.',
    {
      nodes: [
        n('clk', 'syncedclock', { division: Div.quarter }),
        n('pls', 'pulse', { widthSec: 0.06 }),
        n('duck', 'ducker', { amount: 0.8, attack: 0.004, release: 0.25 }),
      ],
      path: ['duck'],
      level: 1,
      wires: [w('clk', 'cv', 'pls', 'input'), w('pls', 'cv', 'duck', 'sidechain')],
    }),
];

const stereoAndWidth: FactoryPatch[] = [
  fx('widener', 'Widener', 'Stereo & Width',
    'Side signal up by half. Check it in mono afterwards: width is borrowed from the centre.',
    { nodes: [n('wd', 'width', { width: 1.6 })], path: ['wd'], level: 1 }),
  fx('haas-spread', 'Haas Spread', 'Stereo & Width',
    'One side delayed by sixteen milliseconds. Under about thirty the ear hears position rather than an echo.',
    { nodes: [n('haas', 'haas', { delayMs: 16 })], path: ['haas'], level: 1 }),
  fx('mono-below', 'Mono Below', 'Stereo & Width',
    'Under 180 Hz folded to mono, above it widened. The standard treatment for a bass that will be cut to vinyl.',
    {
      nodes: [
        n('lo', 'lowpass', { cutoff: 180, q: 0.707 }),
        n('ms', 'monosum'),
        n('hi', 'highpass', { cutoff: 180, q: 0.707 }),
        n('wd', 'width', { width: 1.5 }),
      ],
      path: ['lo', 'ms'],
      level: 1,
      wires: [
        w(lineId, 'audio', 'hi', 'input'),
        w('hi', 'audio', 'wd', 'input'),
        w('wd', 'audio', 'lvl', 'input'),
      ],
    }),
  fx('mid-side-lift', 'Mid Side Lift', 'Stereo & Width',
    'Encode, shelve the top, decode. Between those two nodes the left channel is the middle and the right is the sides.',
    {
      nodes: [
        n('enc', 'midside'),
        n('air', 'highshelf', { freq: 7000, gainDb: 3, q: 0.707 }),
        n('dec', 'midsidedecode'),
      ],
      path: ['enc', 'air', 'dec'],
      level: 0.5,
    }),
  fx('stereo-flip', 'Stereo Flip', 'Stereo & Width',
    'Left becomes right. One module, and it is the fastest way to find out whether a part was panned by accident.',
    { nodes: [n('sw', 'swap')], path: ['sw'], level: 1 }),
  fx('slow-panner', 'Slow Panner', 'Stereo & Width',
    'Once every seven seconds, almost the full width. Slow enough that nobody notices it and the mix moves anyway.',
    { nodes: [n('pan', 'autopan', { rate: 0.15, depth: 0.9 })], path: ['pan'], level: 1 }),
];

const playsItself: FactoryPatch[] = [
  selfPlaying('euclid-bass', 'Euclid Bass',
    'Seven hits in sixteen steps, which is a pattern rather than a faster clock. The sequencer follows the same hits.',
    {
      nodes: [
        n('clk', 'syncedclock', { division: Div.sixteenth }),
        n('euc', 'euclidean', { steps: 16, hits: 7, rotation: 0 }),
        n('pls', 'pulse', { widthSec: 0.01 }),
        n('env', 'dahdsr', { attack: 0.002, hold: 0.01, decay: 0.14, sustain: 0, release: 0.1 }),
        n('seq', 'sequencer', { step0: midi(48), step1: midi(48), step2: midi(60), step3: midi(48), step4: midi(51), step5: midi(48), step6: midi(55), step7: midi(48) }),
        n('osc', 'oscillator', { type: Wave.saw, octave: -1, gain: 0.5 }),
        n('lad', 'ladder', { cutoff: 900, resonance: 0.5, drive: 1.6 }),
      ],
      path: ['osc', 'lad'],
      level: 0.9,
      opens: ['osc'],
      resets: ['euc', 'seq'],
      mods: [mod('eg', 'env', 'cv', 'osc', 'gain', 0, 0.5)],
      wires: [
        w('clk', 'cv', 'euc', 'clock'),
        w('euc', 'cv', 'pls', 'input'),
        w('pls', 'cv', 'env', 'input'),
        w('euc', 'cv', 'seq', 'clock'),
        w('seq', 'cv', 'osc', 'note'),
      ],
    }),
  selfPlaying('acid-sequence', 'Acid Sequence',
    'Sixteenths through a Synth Voice and a ladder. The melody is eight numbers in the sequencer, so change them.',
    {
      nodes: [
        n('clk', 'syncedclock', { division: Div.sixteenth }),
        n('pls', 'pulse', { widthSec: 0.01 }),
        n('env', 'dahdsr', { attack: 0.002, hold: 0.01, decay: 0.12, sustain: 0, release: 0.08 }),
        n('seq', 'sequencer', { step0: midi(52), step1: midi(52), step2: midi(64), step3: midi(55), step4: midi(52), step5: midi(59), step6: midi(52), step7: midi(57) }),
        n('v', 'SynthVoice', { type: Wave.saw, octave: -1, cutoff: 500, resonance: 5, envAmt: 1.2, gain: 0.5 }),
        n('lad', 'ladder', { cutoff: 1100, resonance: 0.72, drive: 2.2 }),
      ],
      path: ['v', 'lad'],
      level: 0.75,
      opens: ['v'],
      resets: ['seq'],
      mods: [mod('ag', 'env', 'cv', 'v', 'gain', 0, 0.5)],
      wires: [
        w('clk', 'cv', 'pls', 'input'),
        w('pls', 'cv', 'env', 'input'),
        w('clk', 'cv', 'seq', 'clock'),
        w('seq', 'cv', 'v', 'note'),
      ],
    }),
  selfPlaying('random-bleeps', 'Random Bleeps',
    'A stepped random into a quantizer, so the notes are random and in key. Change the quantizer\'s root and scale.',
    {
      nodes: [
        n('clk', 'syncedclock', { division: Div.eighth }),
        n('pls', 'pulse', { widthSec: 0.01 }),
        n('env', 'dahdsr', { attack: 0.002, hold: 0.01, decay: 0.16, sustain: 0, release: 0.12 }),
        n('rnd', 'randomstepped', { freq: 3 }),
        n('qnt', 'quantize', { root: 9, scale: 2 }),
        n('osc', 'oscillator', { type: Wave.square, gain: 0.4 }),
        n('lp', 'lowpass', { cutoff: 3200, q: 1.2 }),
        n('dly', 'synceddelay', { division: Div.dottedEighth, feedback: 0.4, mix: 0.32 }),
      ],
      path: ['osc', 'lp', 'dly'],
      level: 0.9,
      opens: ['osc'],
      mods: [mod('rg', 'env', 'cv', 'osc', 'gain', 0, 0.4)],
      wires: [
        w('clk', 'cv', 'pls', 'input'),
        w('pls', 'cv', 'env', 'input'),
        w('rnd', 'audio', 'qnt', 'input'),
        w('qnt', 'audio', 'osc', 'note'),
      ],
    }),
  selfPlaying('slow-arp', 'Slow Arp',
    'An eight step arpeggio on a wavetable with a dotted delay behind it. Eighth notes, so it sits under something.',
    {
      nodes: [
        n('clk', 'syncedclock', { division: Div.eighth }),
        n('pls', 'pulse', { widthSec: 0.02 }),
        n('env', 'dahdsr', { attack: 0.004, hold: 0.02, decay: 0.3, sustain: 0, release: 0.2 }),
        n('seq', 'sequencer', { step0: midi(60), step1: midi(64), step2: midi(67), step3: midi(72), step4: midi(67), step5: midi(64), step6: midi(60), step7: midi(55) }),
        n('wt', 'wavetable', { position: 0.4, gain: 0.4 }),
        n('lp', 'lowpass', { cutoff: 4200, q: 0.9 }),
        n('dly', 'synceddelay', { division: Div.dottedQuarter, feedback: 0.42, mix: 0.3 }),
      ],
      path: ['wt', 'lp', 'dly'],
      level: 0.9,
      opens: ['wt'],
      resets: ['seq'],
      mods: [mod('sg', 'env', 'cv', 'wt', 'gain', 0, 0.4)],
      wires: [
        w('clk', 'cv', 'pls', 'input'),
        w('pls', 'cv', 'env', 'input'),
        w('clk', 'cv', 'seq', 'clock'),
        w('seq', 'cv', 'wt', 'note'),
      ],
    }),
  selfPlaying('techno-pulse', 'Techno Pulse',
    'A quarter note kick and an eighth note hat, each from its own clock. The kick\'s pitch drop is an envelope on a tone.',
    {
      nodes: [
        n('clk', 'syncedclock', { division: Div.quarter }),
        n('pls', 'pulse', { widthSec: 0.01 }),
        n('env', 'dahdsr', { attack: 0.002, hold: 0.01, decay: 0.3, sustain: 0, release: 0.2 }),
        n('tn', 'tone', { freq: 55, gain: 1 }),
        vca('kvca'),
        n('sat', 'softclip', { drive: 1.6 }),
        n('hclk', 'syncedclock', { division: Div.eighth }),
        n('hpls', 'pulse', { widthSec: 0.005 }),
        n('henv', 'dahdsr', { attack: 0.001, hold: 0.004, decay: 0.05, sustain: 0, release: 0.04 }),
        n('nz', 'noise', { color: Noise.white, gain: 1, cutoff: 16000 }),
        vca('hvca'),
        n('hp', 'highpass', { cutoff: 7500, q: 0.9 }),
      ],
      path: ['tn', 'kvca', 'sat'],
      level: 0.75,
      mods: [
        mod('kp', 'env', 'cv', 'tn', 'freq', 45, 240),
        mod('ka', 'env', 'cv', 'kvca', 'gain', 0, 0.8),
        mod('ha', 'henv', 'cv', 'hvca', 'gain', 0, 0.28),
      ],
      wires: [
        w('clk', 'cv', 'pls', 'input'),
        w('pls', 'cv', 'env', 'input'),
        w('hclk', 'cv', 'hpls', 'input'),
        w('hpls', 'cv', 'henv', 'input'),
        w('nz', 'audio', 'hvca', 'input'),
        w('hvca', 'audio', 'hp', 'input'),
        w('hp', 'audio', 'lvl', 'input'),
      ],
    }),
  selfPlaying('ambient-bloom', 'Ambient Bloom',
    'One note a bar, a second of attack on each, and a big room. Leave it running.',
    {
      nodes: [
        n('clk', 'syncedclock', { division: Div.whole }),
        n('pls', 'pulse', { widthSec: 0.3 }),
        n('env', 'dahdsr', { attack: 1.2, hold: 0.2, decay: 2, sustain: 0, release: 2 }),
        n('rnd', 'randomstepped', { freq: 0.25 }),
        n('qnt', 'quantize', { root: 0, scale: 2 }),
        n('osc', 'oscillator', { type: Wave.triangle, gain: 0.45 }),
        n('lp', 'lowpass', { cutoff: 2400, q: 0.8 }),
        n('rev', 'reverb', { size: 1.4, decay: 0.9, damp: 3600, mix: 0.55 }),
      ],
      path: ['osc', 'lp', 'rev'],
      level: 1.6,
      opens: ['osc'],
      mods: [mod('bg', 'env', 'cv', 'osc', 'gain', 0, 0.45)],
      wires: [
        w('clk', 'cv', 'pls', 'input'),
        w('pls', 'cv', 'env', 'input'),
        w('rnd', 'audio', 'qnt', 'input'),
        w('qnt', 'audio', 'osc', 'note'),
      ],
    }),
  selfPlaying('krell', 'Krell',
    'A random voltage sets the clock rate, so the rhythm never settles. The classic self playing patch.',
    {
      nodes: [
        n('drift', 'randomsmooth', { freq: 0.3 }),
        n('clk', 'clock', { freq: 1.5 }),
        n('pls', 'pulse', { widthSec: 0.02 }),
        n('env', 'dahdsr', { attack: 0.06, hold: 0.02, decay: 0.6, sustain: 0, release: 0.5 }),
        n('pick', 'randomstepped', { freq: 0.7 }),
        n('qnt', 'quantize', { root: 2, scale: 1 }),
        n('osc', 'oscillator', { type: Wave.triangle, gain: 0.45 }),
        n('lp', 'lowpass', { cutoff: 2800, q: 1.4 }),
        n('rev', 'reverb', { size: 1.25, decay: 0.86, damp: 4200, mix: 0.45 }),
      ],
      path: ['osc', 'lp', 'rev'],
      level: 1.5,
      opens: ['osc'],
      resets: ['clk'],
      mods: [
        mod('kr', 'drift', 'audio', 'clk', 'freq', 0.4, 3),
        mod('kg', 'env', 'cv', 'osc', 'gain', 0, 0.45),
      ],
      wires: [
        w('clk', 'cv', 'pls', 'input'),
        w('pls', 'cv', 'env', 'input'),
        w('pick', 'audio', 'qnt', 'input'),
        w('qnt', 'audio', 'osc', 'note'),
      ],
    }),
  selfPlaying('poly-clock', 'Poly Clock',
    'One clock divided by three against the same clock multiplied by two. Two voices that agree once a bar and nowhere else.',
    {
      nodes: [
        n('clk', 'syncedclock', { division: Div.eighth }),
        n('slow', 'clockdivide', { factor: 3 }),
        n('fast', 'clockmultiply', { factor: 2 }),
        n('apls', 'pulse', { widthSec: 0.02 }),
        n('aenv', 'dahdsr', { attack: 0.004, hold: 0.02, decay: 0.35, sustain: 0, release: 0.25 }),
        n('bpls', 'pulse', { widthSec: 0.006 }),
        n('benv', 'dahdsr', { attack: 0.001, hold: 0.006, decay: 0.09, sustain: 0, release: 0.07 }),
        n('seq', 'sequencer', { step0: midi(48), step1: midi(55), step2: midi(60), step3: midi(63), step4: midi(60), step5: midi(55), step6: midi(51), step7: midi(55) }),
        n('low', 'oscillator', { type: Wave.triangle, octave: -1, gain: 0.45 }),
        n('pin', 'control', { value: midi(72) }),
        n('high', 'oscillator', { type: Wave.square, gain: 0.3 }),
        n('hp', 'highpass', { cutoff: 900, q: 0.9 }),
        n('lp', 'lowpass', { cutoff: 2600, q: 0.9 }),
      ],
      path: ['low', 'lp'],
      level: 0.9,
      opens: ['low', 'high'],
      resets: ['slow', 'fast', 'seq'],
      mods: [
        mod('ag', 'aenv', 'cv', 'low', 'gain', 0, 0.45),
        mod('bg', 'benv', 'cv', 'high', 'gain', 0, 0.22),
      ],
      wires: [
        w('clk', 'cv', 'slow', 'input'),
        w('clk', 'cv', 'fast', 'input'),
        w('slow', 'cv', 'apls', 'input'),
        w('apls', 'cv', 'aenv', 'input'),
        w('fast', 'cv', 'bpls', 'input'),
        w('bpls', 'cv', 'benv', 'input'),
        w('slow', 'cv', 'seq', 'clock'),
        w('seq', 'cv', 'low', 'note'),
        w('pin', 'audio', 'high', 'note'),
        w('high', 'audio', 'hp', 'input'),
        w('hp', 'audio', 'lvl', 'input'),
      ],
    }),
  selfPlaying('drone-field', 'Drone Field',
    'Two held notes from two Control nodes, each breathing at its own rate. No clock anywhere in it.',
    {
      nodes: [
        n('pinA', 'control', { value: midi(50) }),
        n('pinB', 'control', { value: midi(57) }),
        n('lfoA', 'lfo', { type: Wave.sine, rate: 0.09, amount: 1 }),
        n('lfoB', 'lfo', { type: Wave.sine, rate: 0.14, amount: 1 }),
        n('lfoF', 'lfo', { type: Wave.triangle, rate: 0.05, amount: 1 }),
        n('a', 'oscillator', { type: Wave.saw, octave: -1, gain: 0.3 }),
        n('b', 'oscillator', { type: Wave.triangle, gain: 0.3 }),
        n('lp', 'lowpass', { cutoff: 1400, q: 1.1 }),
        n('rev', 'reverb', { size: 1.4, decay: 0.9, damp: 2800, mix: 0.5 }),
      ],
      path: ['a', 'lp', 'rev'],
      level: 1.4,
      opens: ['a', 'b'],
      mods: [
        mod('ga', 'lfoA', 'cv', 'a', 'gain', 0.06, 0.3),
        mod('gb', 'lfoB', 'cv', 'b', 'gain', 0.05, 0.24),
        mod('gf', 'lfoF', 'cv', 'lp', 'cutoff', 600, 3000),
      ],
      wires: [
        w('pinA', 'audio', 'a', 'note'),
        w('pinB', 'audio', 'b', 'note'),
        w('b', 'audio', 'lp', 'input'),
      ],
    }),
  selfPlaying('noise-rain', 'Noise Rain',
    'Nine hits in sixteen steps on filtered noise, with a random voltage moving the filter. Percussion with no drums in it.',
    {
      nodes: [
        n('clk', 'syncedclock', { division: Div.sixteenth }),
        n('euc', 'euclidean', { steps: 16, hits: 9, rotation: 2 }),
        n('pls', 'pulse', { widthSec: 0.005 }),
        n('env', 'dahdsr', { attack: 0.001, hold: 0.005, decay: 0.09, sustain: 0, release: 0.07 }),
        n('rnd', 'randomstepped', { freq: 6 }),
        n('nz', 'noise', { color: Noise.white, gain: 1, cutoff: 16000 }),
        vca('vca'),
        n('bp', 'bandpass', { cutoff: 2600, q: 3 }),
        n('rev', 'reverb', { size: 1, decay: 0.72, damp: 6000, mix: 0.4 }),
      ],
      path: ['nz', 'vca', 'bp', 'rev'],
      level: 2.2,
      resets: ['euc'],
      mods: [
        mod('ng', 'env', 'cv', 'vca', 'gain', 0, 0.4),
        mod('nf', 'rnd', 'audio', 'bp', 'cutoff', 900, 7000),
      ],
      wires: [
        w('clk', 'cv', 'euc', 'clock'),
        w('euc', 'cv', 'pls', 'input'),
        w('pls', 'cv', 'env', 'input'),
      ],
    }),
];

export const FACTORY_PATCHES: FactoryPatch[] = [
  ...bass,
  ...lead,
  ...pad,
  ...keys,
  ...percussion,
  ...playsItself,
  ...filterAndTone,
  ...driveAndCrush,
  ...delay,
  ...reverbAndSpace,
  ...modulation,
  ...dynamics,
  ...stereoAndWidth,
];
