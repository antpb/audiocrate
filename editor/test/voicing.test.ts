import { describe, expect, it } from 'vitest';
import { NOTE_INPUTS, flattenPatch, planVoicing, type AudioMaterial } from '../../src/index';
import { compileVoice } from '../../src/asl/compile';
import { resolveKind } from '../src/pluginDoc';
import { PATCH_KIND, type CratePatch } from '../src/patch';

/**
 * Which modules of an instrument run per voice and which once on the sum, and
 * whether the split renders what the patch means. See `src/patcher/voicing.ts`.
 */
type Node = CratePatch['nodes'][number];
type Cable = CratePatch['connections'][number];

const node = (id: string, kind: string, params: Record<string, number> = {}, extra: Partial<Node> = {}): Node =>
  ({ id, kind, params, x: 0, y: 0, ...extra }) as Node;
const cable = (source: string, sourceOutput: string, target: string, targetInput: string): Cable => ({
  source,
  sourceOutput,
  target,
  targetInput,
});
const patch = (nodes: Node[], connections: Cable[]): CratePatch =>
  ({ kind: PATCH_KIND, version: 1, nodes, connections }) as CratePatch;

/** The traced patch: keys -> oscillator -> lowpass -> reverb -> gain -> limiter. */
const reverbInstrument = (voicing: Partial<Record<string, 'instanced' | 'summed'>> = {}): CratePatch =>
  patch(
    [
      node('keys', 'keyboard'),
      node('osc', 'oscillator', { attack: 0.002, decay: 1.1, gain: 0.34, release: 0.4, sustain: 0.15, type: 5, width: 0.3 }),
      node('lp', 'lowpass', { cutoff: 1597, q: 4.8 }, voicing.lp ? { voicing: voicing.lp } : {}),
      node('rev', 'reverb', { damp: 5000, decay: 0.55, mix: 0.22, size: 0.7 }, voicing.rev ? { voicing: voicing.rev } : {}),
      node('lvl', 'gain', { gain: 0.27 }, voicing.lvl ? { voicing: voicing.lvl } : {}),
      node('lim', 'limiter', { attack: 0.002, release: 0.08, threshold: 0.6 }, voicing.lim ? { voicing: voicing.lim } : {}),
      node('out', 'master'),
    ],
    [
      cable('keys', 'cv', 'osc', 'note'),
      cable('keys', 'gate', 'osc', 'gate'),
      cable('osc', 'audio', 'lp', 'input'),
      cable('lp', 'audio', 'rev', 'input'),
      cable('rev', 'audio', 'lvl', 'input'),
      cable('lvl', 'audio', 'lim', 'input'),
      cable('lim', 'audio', 'out', 'input'),
    ],
  );

const flatten = (p: CratePatch): AudioMaterial => flattenPatch(p, { resolve: resolveKind, role: 'instrument' });

const roles = (p: CratePatch) => {
  const materials = new Map<string, AudioMaterial>();
  for (const n of p.nodes) {
    const m = resolveKind(n.kind);
    if (m) materials.set(n.id, m);
  }
  return planVoicing({
    nodes: p.nodes,
    connections: p.connections,
    materials,
    voiceSourceKinds: new Set(['keyboard', 'midiin']),
    noteInputs: NOTE_INPUTS,
  });
};

const SR = 48000;
const FRAMES = 256;

/**
 * `voices` notes held for `blocks` blocks, then released: summed over voices
 * the way a polyphonic host does, each voice its own state and seed.
 * Unsplit, that is every voice's whole chain summed. Split, it is every
 * voice's sends summed and the bus run once on the sum.
 */
function renderChord(material: AudioMaterial, notes: number[], blocks = 40): Float32Array {
  const out = new Float32Array(FRAMES * blocks);
  const params = material.snapshotParams();
  const split = material.graph.bus !== undefined;
  const voice = compileVoice(material.graph, { sends: split });
  const states = notes.map((note, i) => {
    const state = voice.createState({ seed: 11 + i });
    voice.noteOn(state, { ...params, note, velocity: 0.8 });
    return state;
  });
  const bus = split ? compileVoice(material.graph.bus!) : null;
  const busState = bus?.createState({ seed: 99 });
  if (busState) {
    busState.gate = true;
    Object.assign(busState.params, params);
  }
  const k = voice.sendCount;
  const sum = Array.from({ length: k }, () => new Float32Array(FRAMES));
  const send = Array.from({ length: k }, () => new Float32Array(FRAMES));
  const block = new Float32Array(FRAMES);
  for (let b = 0; b < blocks; b++) {
    if (b === blocks / 2) for (const s of states) voice.noteOff(s);
    for (const s of sum) s.fill(0);
    const mixed = new Float32Array(FRAMES);
    for (const state of states) {
      voice.renderBlock(state, SR, block, undefined, split ? { sends: { left: send } } : {});
      if (split) for (let j = 0; j < k; j++) for (let i = 0; i < FRAMES; i++) sum[j]![i]! += send[j]![i]!;
      else for (let i = 0; i < FRAMES; i++) mixed[i]! += block[i]!;
    }
    if (bus && busState) {
      const ports: Record<string, (Float32Array | undefined)[]> = {};
      for (let j = 0; j < k; j++) ports[`send${j}`] = [sum[j]];
      bus.renderBlock(busState, SR, mixed, undefined, { ports });
    }
    out.set(mixed, b * FRAMES);
  }
  return out;
}

const maxDiff = (a: Float32Array, b: Float32Array): number => {
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
};
const peak = (a: Float32Array): number => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('instrument voicing', () => {
  it('runs the oscillator per voice and everything after it once, on the sum', () => {
    const plan = roles(reverbInstrument());
    expect(Object.fromEntries(plan.role)).toEqual({
      osc: 'instanced',
      lp: 'summed',
      rev: 'summed',
      lvl: 'summed',
      lim: 'summed',
    });
    const material = flatten(reverbInstrument());
    expect(material.graph.bus).toBeDefined();
    expect(material.graph.sends).toHaveLength(1);
  });

  it('keeps a module per voice when a per-voice signal drives one of its controls', () => {
    const p = reverbInstrument();
    p.nodes.push(node('env', 'adsr', {}));
    p.connections.push(cable('keys', 'gate', 'env', 'gate'), cable('env', 'cv', 'lp', 'cutoff'));
    const plan = roles(p);
    expect(plan.role.get('lp')).toBe('instanced');
    expect(plan.canSum.get('lp')).toBe(false);
    expect(plan.reason.get('lp')).toMatch(/cutoff/);
    expect(plan.role.get('rev')).toBe('summed');
  });

  it('keeps a module per voice when voice signals reach two of its audio inputs', () => {
    // A ring modulator on two summed inputs would multiply every voice by
    // every other. Combining inputs has to happen inside each voice.
    const p = patch(
      [
        node('keys', 'keyboard'),
        node('car', 'oscillator'),
        node('mod', 'oscillator', { octave: 1 }),
        node('ring', 'audiomultiply'),
        node('rev', 'reverb'),
        node('out', 'master'),
      ],
      [
        cable('keys', 'cv', 'car', 'note'),
        cable('keys', 'gate', 'car', 'gate'),
        cable('keys', 'cv', 'mod', 'note'),
        cable('keys', 'gate', 'mod', 'gate'),
        cable('car', 'audio', 'ring', 'input'),
        cable('mod', 'audio', 'ring', 'sidechain'),
        cable('ring', 'audio', 'rev', 'input'),
        cable('rev', 'audio', 'out', 'input'),
      ],
    );
    const plan = roles(p);
    expect(plan.role.get('ring')).toBe('instanced');
    expect(plan.canSum.get('ring')).toBe(false);
    expect(plan.reason.get('ring')).toMatch(/more than one input/);
    expect(plan.role.get('rev')).toBe('summed');
  });

  it("honours voicing: 'instanced', and keeps everything feeding it per voice too", () => {
    const plan = roles(reverbInstrument({ rev: 'instanced' }));
    expect(plan.role.get('rev')).toBe('instanced');
    expect(plan.role.get('lp')).toBe('instanced');
    expect(plan.role.get('lvl')).toBe('summed');
    expect(plan.canSum.get('rev')).toBe(true);
  });

  it('does not split an instrument with nothing to sum, so it flattens as it always did', () => {
    const p = patch(
      [node('keys', 'keyboard'), node('osc', 'oscillator'), node('out', 'master')],
      [cable('keys', 'cv', 'osc', 'note'), cable('keys', 'gate', 'osc', 'gate'), cable('osc', 'audio', 'out', 'input')],
    );
    const material = flatten(p);
    expect(material.graph.bus).toBeUndefined();
    expect(material.graph.sends).toBeUndefined();
  });

  it('does not split an insert', () => {
    const p = reverbInstrument();
    const material = flattenPatch(p, { resolve: resolveKind, role: 'insert' });
    expect(material.graph.bus).toBeUndefined();
  });

  it('renders one voice the same split or not, apart from float rounding at the send', () => {
    const split = flatten(reverbInstrument());
    const whole = flatten(reverbInstrument({ lp: 'instanced', rev: 'instanced', lvl: 'instanced', lim: 'instanced' }));
    expect(whole.graph.bus).toBeUndefined();
    const a = renderChord(split, [57]);
    const b = renderChord(whole, [57]);
    expect(peak(a)).toBeGreaterThan(0.01);
    expect(maxDiff(a, b)).toBeLessThan(1e-5);
  });

  it('sums a chord into the linear chain exactly as per-voice copies would', () => {
    // Without the limiter the chain after the oscillator is linear, so one
    // reverb on the sum must equal the sum of four reverbs.
    const linear = (voicing: Partial<Record<string, 'instanced' | 'summed'>>) => {
      const p = reverbInstrument(voicing);
      p.nodes = p.nodes.filter((n) => n.id !== 'lim');
      p.connections = p.connections.filter((c) => c.source !== 'lim' && c.target !== 'lim');
      p.connections.push(cable('lvl', 'audio', 'out', 'input'));
      return p;
    };
    const split = flatten(linear({}));
    const whole = flatten(linear({ lp: 'instanced', rev: 'instanced', lvl: 'instanced' }));
    const chord = [48, 55, 60, 64];
    const a = renderChord(split, chord);
    const b = renderChord(whole, chord);
    expect(peak(a)).toBeGreaterThan(0.01);
    expect(maxDiff(a, b)).toBeLessThan(1e-4);
  });

  it('limits the chord once rather than each note on its own', () => {
    const split = renderChord(flatten(reverbInstrument()), [48, 55, 60, 64, 67, 72]);
    const whole = renderChord(
      flatten(reverbInstrument({ lp: 'instanced', rev: 'instanced', lvl: 'instanced', lim: 'instanced' })),
      [48, 55, 60, 64, 67, 72],
    );
    // Six voices, each under the threshold on its own but not together: per
    // voice, nothing limits; summed, the chord is held near the threshold.
    expect(peak(split)).toBeLessThanOrEqual(peak(whole) + 1e-6);
  });

  it('hands the bus one send per distinct per-voice signal', () => {
    const p = patch(
      [
        node('keys', 'keyboard'),
        node('a', 'oscillator', { type: 1 }),
        node('b', 'oscillator', { type: 2 }),
        node('rev', 'reverb', {}),
        node('out', 'master'),
      ],
      [
        cable('keys', 'cv', 'a', 'note'),
        cable('keys', 'gate', 'a', 'gate'),
        cable('keys', 'cv', 'b', 'note'),
        cable('keys', 'gate', 'b', 'gate'),
        cable('a', 'audio', 'rev', 'input'),
        cable('b', 'audio', 'rev', 'input'),
        cable('rev', 'audio', 'out', 'input'),
        cable('a', 'audio', 'out', 'input'),
      ],
    );
    const material = flatten(p);
    expect(material.graph.sends).toHaveLength(2);
    const whole = flatten({ ...p, nodes: p.nodes.map((n) => (n.id === 'rev' ? { ...n, voicing: 'instanced' } : n)) });
    expect(whole.graph.bus).toBeUndefined();
    const chord = [50, 57, 62];
    expect(maxDiff(renderChord(material, chord), renderChord(whole, chord))).toBeLessThan(1e-4);
  });

  it('renders a split voice whole when compiled without sends, for a one-voice host', () => {
    const material = flatten(reverbInstrument());
    const voice = compileVoice(material.graph);
    const state = voice.createState({ seed: 11 });
    voice.noteOn(state, { ...material.snapshotParams(), note: 57, velocity: 0.8 });
    const out = new Float32Array(FRAMES);
    let heard = 0;
    for (let b = 0; b < 20; b++) {
      voice.renderBlock(state, SR, out);
      heard = Math.max(heard, peak(out));
    }
    expect(heard).toBeGreaterThan(0.01);
    expect(maxDiff(new Float32Array(renderChord(material, [57]).subarray(0, FRAMES * 20)), (() => {
      const v = compileVoice(material.graph);
      const s = v.createState({ seed: 11 });
      v.noteOn(s, { ...material.snapshotParams(), note: 57, velocity: 0.8 });
      const all = new Float32Array(FRAMES * 20);
      const blk = new Float32Array(FRAMES);
      for (let b = 0; b < 20; b++) {
        v.renderBlock(s, SR, blk);
        all.set(blk, b * FRAMES);
      }
      return all;
    })())).toBeLessThan(1e-6);
  });
});
