/**
 * Every palette parameter, swept the way a knob moves it.
 *
 * For each material and each automatable range parameter, render with the
 * parameter held at each end of a sweep, then swept between them at 60
 * updates a second. A sweep whose worst sample-to-sample jump is far beyond
 * both held renders' is a click the motion caused.
 *
 * The first run of this found two real defects, both fixed: the SVF went NaN
 * above 6.6 kHz at the default Q (held, not only swept), and changing an
 * envelope's attack or decay mid-stage teleported its level. A non-finite
 * sample anywhere fails outright.
 *
 * Continuous parameters glide when a host moves them (`CompiledVoice.setParam`),
 * which is what cleared the zipper this used to list: gains, sustain levels,
 * depths and control values stepping at knob rate.
 *
 * Some jumps are the parameter doing its job and are listed with the reason.
 * The list is exact: a new click fails, and so does a listed one that has
 * gone, so the list cannot rot into a blanket exemption.
 */
import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../src/asl/compile';
import { denormalizeParam } from '../../src/graph/param';
import { buildMaterialCatalog, type CatalogMaterialEntry } from '../src/materialCatalog';

const SR = 48000;
const BLOCK = 128;
const BLOCKS = Math.round((0.6 * SR) / BLOCK);
const PER_STEP = Math.round(SR / BLOCK / 60);

/** A step in the parameter is a step in the output, by definition. */
const BY_DESIGN: Record<string, string> = {
  'trigger.threshold': 'a trigger fires when its threshold crosses the signal',
  'comparegt.threshold': 'a comparator output is 0 or 1',
  'comparelt.threshold': 'a comparator output is 0 or 1',
  'logicor.other': 'logic output is 0 or 1',
  'logicxor.other': 'logic output is 0 or 1',
  'gate.threshold': 'a gate opening or closing is the point of a gate',
  // Not motion at all: held still at 0.5 the table's own worst jump is 0.53,
  // because its middle frames are saw- and square-like and have edges. A
  // sweep visits them and the two held ends (0.1, 0.9) do not.
  'wavetable.position': "the table's middle frames have edges of their own",
};

/**
 * Motion a glide cannot take out, because the node already glides.
 *
 * Every continuous parameter glides over `PARAM_RAMP_SECONDS` when a host
 * changes it (`isSmoothedParam`). 5 ms is the shortest length that cleared
 * every zipper finding (gains, sustain, depth, CV values); 2 ms left one. What
 * remains here is the delay's own 20 ms read-pointer glide, which is a pitch
 * bend on a fast downward sweep and is meant to be.
 */
const NODE_GLIDES: Record<string, string> = {
  'delay.timeSec': 'the read-pointer glide is a pitch bend, fast on a fast downward sweep',
};

function run(material: CatalogMaterialEntry, param: string, from: number, to: number, move: boolean) {
  const voice = compileVoice(material.graph as never);
  const state = voice.createState();
  for (const name of material.paramOrder) state.params[name] = material.params[name]!.default;
  state.params[param] = from;
  voice.noteOn(state, { note: 57, velocity: 0.8 });
  const insert = material.audioInputs.includes('input');
  const input = new Float32Array(BLOCK);
  const out = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  let phase = 0;
  let prevL = 0;
  let prevR = 0;
  let jump = 0;
  let finite = true;
  for (let b = 0; b < BLOCKS; b++) {
    for (let i = 0; i < BLOCK; i++) input[i] = Math.sin((2 * Math.PI * 220 * phase++) / SR) * 0.5;
    if (move && b % PER_STEP === 0) {
      voice.setParam(state, param, from + (to - from) * Math.min(1, b / (BLOCKS * 0.75)));
    }
    const stereo = voice.renderBlock(state, SR, out, insert ? input : undefined, {
      inputR: insert ? input : undefined,
      outputR: outR,
      transport: { beats: (b * BLOCK * 2) / SR, bpm: 120, playing: true, beatsPerBar: 4, beatUnit: 4 },
    });
    for (let i = 0; i < BLOCK; i++) {
      const l = out[i]!;
      const r = stereo ? outR[i]! : l;
      if (!Number.isFinite(l) || !Number.isFinite(r)) finite = false;
      // Past the first few blocks, so a note's own attack is not counted.
      if (b > 4) jump = Math.max(jump, Math.abs(l - prevL), Math.abs(r - prevR));
      prevL = l;
      prevR = r;
    }
  }
  return { jump, finite };
}

describe('palette parameters in motion', () => {
  const clicks = new Set<string>();
  const nonFinite: string[] = [];

  for (const material of buildMaterialCatalog().materials) {
    for (const param of material.automatable) {
      const descriptor = material.params[param];
      if (!descriptor || descriptor.kind === 'enum' || descriptor.kind === 'toggle') continue;
      for (const [u0, u1] of [
        [0.1, 0.9],
        [0.9, 0.1],
      ] as const) {
        const a = denormalizeParam(descriptor, u0);
        const b = denormalizeParam(descriptor, u1);
        const heldA = run(material, param, a, a, false);
        const heldB = run(material, param, b, b, false);
        const swept = run(material, param, a, b, true);
        const key = `${material.kind}.${param}`;
        if (!heldA.finite || !heldB.finite || !swept.finite) nonFinite.push(`${key} ${u0}->${u1}`);
        else if (swept.jump > 3 * Math.max(heldA.jump, heldB.jump) + 0.02) clicks.add(key);
      }
    }
  }

  it('never renders a non-finite sample, held or moving', () => {
    expect(nonFinite).toEqual([]);
  });

  it('clicks only where a step is the parameter doing its job', () => {
    const allowed = new Set([...Object.keys(BY_DESIGN), ...Object.keys(NODE_GLIDES)]);
    expect([...clicks].filter((key) => !allowed.has(key)).sort(), 'new clicks').toEqual([]);
    expect([...allowed].filter((key) => !clicks.has(key)).sort(), 'listed but no longer clicking').toEqual([]);
  });
});
