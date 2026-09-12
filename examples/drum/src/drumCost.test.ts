/**
 * What a sixteen-pad sampler costs as a graph.
 *
 * Not a performance gate. The numbers move with the machine and a threshold
 * here would fail on somebody's laptop for no useful reason. It exists to
 * keep the shape of the cost visible, because the shape is the finding: a
 * graph has no control flow, so all sixteen pads are evaluated on every
 * sample whether they are sounding or not, and a stereo graph does that
 * twice.
 *
 * Run with `--reporter=verbose` to read the measurements.
 */
import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../../src/asl/compile';
import { ASL, mix, samplePlay, uniform, type ASLNode, type SampleBox } from './crate';
import { bitCrusher026S, bitTrim, cascadeLowpass3, padLowpass, panned } from './drumDsp';
import { createDrumMaterial } from './drumMaterial';
import { NUM_PADS, PAD_BASE_NOTE } from './drumParams';
import { setDrumPadAsset } from './drumPads';

const SR = 48000;

/** Distinct nodes in the graph, which is what the evaluator allocates a slot for. */
function countNodes(root: ASLNode): number {
  const seen = new Set<ASLNode>();
  const walk = (node: ASLNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of Object.values(node.inputs)) walk(child);
    for (const child of node.list ?? []) walk(child);
  };
  walk(root);
  return seen.size;
}

describe('drum cost', () => {
  it('is sixteen parallel chains, because a pad cannot be chosen, only compared', () => {
    const material = createDrumMaterial({ sampleRate: SR });
    const nodes = countNodes(material.graph.output);
    const voice = compileVoice(material.graph);
    // eslint-disable-next-line no-console
    console.log(
      `drum graph: ${nodes} nodes, ${Math.round(nodes / NUM_PADS)} per pad, ` +
        `${voice.blockConstantNodes} of them block constant`,
    );
    expect(nodes).toBeGreaterThan(NUM_PADS * 20);
    // Most of a pad chain is coefficient arithmetic over its own parameters.
    expect(voice.blockConstantNodes).toBeGreaterThan(nodes / 3);
  });

  it('reports where the samples go, stage by stage', () => {
    // Sixteen of each stage, the way the instrument has sixteen. Only the pan
    // graph reads the channel index, so only that one is evaluated twice per
    // sample; the whole instrument is, which is why its figure is lower than
    // any single stage here.
    const samples = new Float32Array(65536);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * 180 * i) / SR) * 0.5;
    }
    const box: SampleBox = { samples, sampleRate: SR };
    const source = () => samplePlay({ rate: 1, box });
    const sixteen = (build: () => ReturnType<typeof source>) =>
      ASL.node(() => mix(...Array.from({ length: 16 }, build)));

    const stages: Record<string, ReturnType<typeof ASL.node>> = {
      'sample players': sixteen(source),
      'bit crusher': ASL.node(({ bits, srate }) =>
        mix(
          ...Array.from({ length: 16 }, () =>
            bitCrusher026S(source(), { bits, srate, sampleRate: SR }).mul(bitTrim(bits)),
          ),
        ),
      ),
      'pad low-pass': ASL.node(({ cut, res }) =>
        mix(...Array.from({ length: 16 }, () => padLowpass(source(), { cutoff: cut, res }))),
      ),
      pan: ASL.node(({ pan }) => mix(...Array.from({ length: 16 }, () => panned(source(), pan)))),
      'master chain': ASL.node(({ cut, res }) =>
        cascadeLowpass3(cascadeLowpass3(source(), { cutoff: cut, res, sampleRate: SR }), {
          cutoff: uniform(17000),
          res: uniform(0.18),
          sampleRate: SR,
        }),
      ),
    };

    const params = { bits: 16, srate: 1, cut: 20000, res: 0, pan: 0 };
    for (const [name, graph] of Object.entries(stages)) {
      const voice = compileVoice(graph);
      const state = voice.createState();
      for (const [key, value] of Object.entries(params)) state.params[key] = value;
      voice.noteOn(state, { note: PAD_BASE_NOTE, velocity: 1, ...params });
      const out = new Float32Array(128);
      const outR = new Float32Array(128);
      // Warm the caches and the JIT before the timed run.
      for (let b = 0; b < 40; b++) voice.renderBlock(state, SR, out, undefined, { outputR: outR });
      const started = performance.now();
      for (let b = 0; b < 200; b++) voice.renderBlock(state, SR, out, undefined, { outputR: outR });
      const ratio = (128 * 200) / SR / ((performance.now() - started) / 1000);
      // eslint-disable-next-line no-console
      console.log(
        `  ${name.padEnd(15)} ${String(countNodes(graph.output)).padStart(5)} nodes ` +
          `(${String(voice.blockConstantNodes).padStart(4)} block constant)  ${ratio.toFixed(2)}x real time`,
      );
      expect(ratio).toBeGreaterThan(0);
    }
  });

  it('renders, and reports how far ahead of real time it does it', () => {
    const material = createDrumMaterial({ sampleRate: SR });
    const samples = new Float32Array(4096);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * 180 * i) / SR) * Math.exp(-i / 2000);
    }
    for (let pad = 0; pad < NUM_PADS; pad++) {
      setDrumPadAsset(material, pad, { filename: `pad${pad}.wav`, samples, sampleRate: SR });
    }

    const voice = compileVoice(material.graph);
    const state = voice.createState();
    voice.noteOn(state, { ...material.snapshotParams(), note: PAD_BASE_NOTE, velocity: 1 });

    const frames = 128;
    const blocks = 200;
    const out = new Float32Array(frames);
    const outR = new Float32Array(frames);
    const started = performance.now();
    for (let b = 0; b < blocks; b++) {
      voice.renderBlock(state, SR, out, undefined, { outputR: outR });
    }
    const elapsed = (performance.now() - started) / 1000;
    const audioSeconds = (frames * blocks) / SR;
    // eslint-disable-next-line no-console
    console.log(
      `drum render: ${audioSeconds.toFixed(3)}s of audio in ${elapsed.toFixed(3)}s ` +
        `(${(audioSeconds / elapsed).toFixed(2)}x real time)`,
    );
    expect(elapsed).toBeGreaterThan(0);
  });
});
