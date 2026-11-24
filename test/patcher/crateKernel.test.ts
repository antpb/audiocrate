/**
 * The CrateC kernel (examples/CrateC/web) against the JS interpreter.
 *
 * The web plays a crate patch through CrateC for speed, and through
 * `asl/compile.ts` everywhere else (offline, bakes, a host without the
 * kernel). Both read the same compiled document, so they must agree on every
 * sample. Needs `examples/CrateC/web/build.sh` to have been run.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { param } from '../../src/graph/param';
import { audio, env, filter, osc } from '../../src/asl/builders';
import { ASLValue } from '../../src/asl/ASLValue';
import { compileVoice } from '../../src/asl/compile';
import { compileMaterial } from '../../src/patcher/compiledPlugin';
import { flattenPatch, type PatchDocument } from '../../src/patcher/flattenPatch';
import { materialFromCompiled } from '../../src/patcher/nativeCrate';
import { synthVoiceMaterial } from '../../src/materials/synthVoice';
import { crateKernelFactory } from '../../examples/CrateC/web/src/kernel';

const WASM = new URL('../../examples/CrateC/web/dist/crate_web.wasm', import.meta.url);
const SR = 48000;
const wasm = () => fs.readFileSync(WASM).buffer.slice(0) as ArrayBuffer;
const transport = { beats: 0, bpm: 120, playing: true, beatsPerBar: 4, beatUnit: 4 };

async function compare(material: AudioMaterial, instrument: boolean, blocks = 120) {
  const compiled = JSON.parse(JSON.stringify(compileMaterial(material, instrument ? 'instrument' : 'insert', material.polyphony)));
  const reference = materialFromCompiled(compiled, { kind: 'test' });
  const params = reference.snapshotParams();
  const kernel = (await crateKernelFactory(SR, { wasm: wasm(), graph: JSON.stringify(compiled.graph), instrument, polyphony: material.polyphony, seed: 0 }))!;
  const voice = compileVoice(reference.graph);
  const state = voice.createState();
  for (const [k, v] of Object.entries(params)) voice.setParam(state, k, v);
  voice.noteOn(state, instrument ? { ...params, note: 57, velocity: 0.9 } : params);
  kernel.applyParams!(params);
  if (instrument) kernel.noteOn!(57, 0.9);
  const tone = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 7) * 0.4);
  const js = new Float32Array(128);
  const jsR = new Float32Array(128);
  const c = new Float32Array(128);
  const cR = new Float32Array(128);
  let worst = 0;
  let loud = 0;
  for (let b = 0; b < blocks; b++) {
    voice.renderBlock(state, SR, js, instrument ? undefined : tone, { transport, outputR: jsR, ...(instrument ? {} : { inputR: tone }) });
    kernel.setTransport!(transport);
    kernel.processSource!(instrument ? new Float32Array(128) : tone, instrument ? null : tone, c, cR);
    for (let i = 0; i < 128; i++) {
      worst = Math.max(worst, Math.abs(js[i]! - c[i]!));
      loud = Math.max(loud, Math.abs(js[i]!));
    }
  }
  kernel.dispose!();
  return { worst, loud };
}

describe.skipIf(!fs.existsSync(WASM))('the CrateC kernel', () => {
  it('plays an instrument sample for sample as the JS interpreter does', async () => {
    const { worst, loud } = await compare(synthVoiceMaterial, true);
    expect(loud).toBeGreaterThan(0.05);
    expect(worst).toBe(0);
  });

  it('processes an effect sample for sample as the JS interpreter does', async () => {
    const crusher = new AudioMaterial({
      name: 'Lowpass',
      params: { cutoff: param.range(80, 12000, { default: 900, curve: 'log' }) },
      graph: ({ params }) => filter.lowpass(audio.input(), { cutoff: params.cutoff! }).mul(0.8),
    });
    const { worst, loud } = await compare(crusher, false);
    expect(loud).toBeGreaterThan(0.05);
    expect(worst).toBe(0);
  });

  it('gives a split instrument the params only its bus reads', async () => {
    // A voice into a gain after the voices sum: the gain's level is read by
    // the bus alone. A kernel that only knew the voice's params left it at 0.
    const tone = new AudioMaterial({
      name: 'Tone',
      kind: 'test.tone',
      polyphony: 4,
      graph: ({ note }) => osc({ freq: new ASLValue(note!.node).toFrequency() }).mul(env.dahdsr({ attack: 0, decay: 0, sustain: 1, release: 0 })),
    });
    const level = new AudioMaterial({
      name: 'Level',
      kind: 'test.level',
      params: { gain: param.range(0, 2, { default: 0.7 }) },
      graph: ({ input, params }) => input!.mul(params.gain!),
    });
    const patch: PatchDocument = {
      nodes: [
        { id: 'keys', kind: 'keyboard' },
        { id: 'osc', kind: 'test.tone' },
        { id: 'lvl', kind: 'test.level' },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'keys', sourceOutput: 'cv', target: 'osc', targetInput: 'note' },
        { source: 'keys', sourceOutput: 'gate', target: 'osc', targetInput: 'gate' },
        { source: 'osc', sourceOutput: 'audio', target: 'lvl', targetInput: 'input' },
        { source: 'lvl', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    };
    const material = flattenPatch(patch, {
      resolve: (kind) => (kind === 'test.tone' ? tone : kind === 'test.level' ? level : null),
      role: 'instrument',
      polyphony: 4,
    });
    expect(material.graph.bus).toBeDefined();
    const { worst, loud } = await compare(material, true);
    expect(loud).toBeGreaterThan(0.05);
    expect(worst).toBe(0);
  });
});
