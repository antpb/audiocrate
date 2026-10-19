/**
 * Seeded `noise` and `random`.
 *
 * The literal draws below are pinned in `RngTests.swift` too. The conformance
 * fixture renders at the default seed only, so these are what hold the two
 * languages together at every other seed, rank and channel.
 */
import { describe, expect, it } from 'vitest';
import { ASL } from '../../src/asl/graph';
import { compileVoice, randomRanks } from '../../src/asl/compile';
import type { ASLNode } from '../../src/asl/types';
import { audio, noise, random, uniform } from '../../src/asl/builders';
import { nextUniform, normalizeSeed, streamSeed } from '../../src/asl/rng';
import { OfflineRenderer } from '../../src/renderers/OfflineRenderer';
import { BlockRenderer } from '../../src/renderers/BlockRenderer';
import { AudioMaterial } from '../../src/graph/AudioMaterial';

const SR = 48000;

describe('rng streams', () => {
  const rows: [number, number, number, number[], number][] = [
    [12345, 0, 0, [0.63517789961770177, 0.17278801347129047, 0.99750317120924592], 2182334657],
    [12345, 1, 0, [0.48469644016586244, 0.10247468296438456, 0.67741280770860612], 1294579196],
    [12345, 0, 1, [0.036649140063673258, 0.072640679078176618, 0.021144072990864515], 3313936347],
    [4294967295, 3, 1, [0.14400545717217028, 0.14127441612072289, 0.26529787667095661], 329059612],
  ];

  it.each(rows)('seed %i rank %i lane %i draws what Swift draws', (seed, rank, lane, draws, after) => {
    const state = { rng: streamSeed(seed, rank, lane) };
    expect([nextUniform(state), nextUniform(state), nextUniform(state)]).toEqual(draws);
    expect(state.rng).toBe(after);
  });

  it('normalizes a seed as ToUint32', () => {
    expect(normalizeSeed(-1)).toBe(4294967295);
    expect(normalizeSeed(4294967296 + 7.9)).toBe(7);
    expect(normalizeSeed(-7.9)).toBe(4294967289);
    expect(normalizeSeed(Number.NaN)).toBe(0);
  });

  it('draws stay in [0, 1) and are not obviously lumpy', () => {
    const state = { rng: streamSeed(1, 0, 0) };
    const bins = new Array<number>(10).fill(0);
    for (let i = 0; i < 100000; i++) {
      const x = nextUniform(state);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      bins[Math.floor(x * 10)]! += 1;
    }
    for (const count of bins) expect(Math.abs(count - 10000)).toBeLessThan(500);
  });
});

describe('seeded voices', () => {
  const render = (graph: ReturnType<typeof ASL.node>, seed?: number, frames = 256) => {
    const voice = compileVoice(graph);
    const state = voice.createState(seed === undefined ? undefined : { seed });
    voice.noteOn(state, {});
    return Array.from({ length: frames }, () => voice.renderSample(state, SR));
  };

  it('one seed renders the same noise twice, and the default is a seed', () => {
    const graph = ASL.node(() => noise({ color: 'pink' }));
    expect(render(graph, 42)).toEqual(render(graph, 42));
    expect(render(graph)).toEqual(render(graph));
    expect(render(graph, 42)).not.toEqual(render(graph, 43));
  });

  it('two random nodes in one graph draw from different streams', () => {
    const a = render(ASL.node(() => noise()), 5);
    const both = render(ASL.node(() => noise().mul(0).add(noise())), 5);
    // The second noise has a higher id, so rank 1: a different stream from
    // the single-noise graph's rank 0.
    expect(both).not.toEqual(a);
  });

  it('a rebuilt graph keeps its streams, because rank follows the shape', () => {
    const build = () => ASL.node(() => noise().mul(0.5).add(random({ freq: uniform(3000) }).mul(0.5)));
    expect(render(build(), 9)).toEqual(render(build(), 9));
  });

  it('streams do not depend on node ids at all', () => {
    // The palette catalog renumbers ids and each language's flatten mints new
    // ones. Reversing every id must not move a single sample.
    const graph = ASL.node(() => {
      const stepped = random({ freq: uniform(3000) });
      return noise({ color: 'pink' }).mul(0.5).add(stepped.mul(0.5));
    });
    const reversed = (node: ASLNode, memo = new Map<number, ASLNode>()): ASLNode => {
      const done = memo.get(node.id);
      if (done) return done;
      const inputs: Record<string, ASLNode> = {};
      for (const [key, child] of Object.entries(node.inputs)) inputs[key] = reversed(child, memo);
      const out = { ...node, id: 1_000_000 - node.id, inputs, list: node.list?.map((c) => reversed(c, memo)) };
      memo.set(node.id, out);
      return out;
    };
    const renumbered = { ...graph, output: reversed(graph.output) };
    expect(render(renumbered, 4)).toEqual(render(graph, 4));
  });

  it('ranks by shape: inputs in sorted name order, first visit wins', () => {
    const graph = ASL.node(() => {
      const first = random({ freq: uniform(10) });
      return noise().add(first);
    });
    const ranks = randomRanks(graph.output);
    const kindOf = new Map<number, string>();
    const walk = (node: ASLNode): void => {
      kindOf.set(node.id, node.kind);
      Object.values(node.inputs).forEach(walk);
    };
    walk(graph.output);
    const byRank = [...ranks.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => kindOf.get(id));
    expect(byRank).toEqual(['noise', 'random']);
  });

  it('a bounce is reproducible by default and seedable', () => {
    const graph = ASL.node(() => noise());
    const once = OfflineRenderer.render(graph, { duration: 0.01 }).samples;
    const twice = OfflineRenderer.render(graph, { duration: 0.01 }).samples;
    expect(twice).toEqual(once);
    const other = OfflineRenderer.render(graph, { duration: 0.01, seed: 1 }).samples;
    expect(other).not.toEqual(once);
  });

  it('BlockRenderer.reset replays the same noise', () => {
    const renderer = new BlockRenderer(ASL.node(() => noise()), { seed: 3 });
    const first = Float32Array.from(renderer.render(128).left);
    renderer.reset();
    expect(Float32Array.from(renderer.render(128).left)).toEqual(first);
  });

  it('the two channels of a stereo insert are two noises', () => {
    const voice = compileVoice(ASL.node(() => audio.input().mul(0).add(noise())));
    const state = voice.createState();
    voice.noteOn(state, {});
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    const silence = new Float32Array(128);
    const wroteRight = voice.renderBlock(state, SR, left, silence, { inputR: silence, outputR: right });
    expect(wroteRight).toBe(true);
    expect(right).not.toEqual(left);
  });

  it('AudioMaterial.bind seeds voice i with seed + i, and leaves it to the renderer otherwise', async () => {
    const material = new AudioMaterial({
      name: 'Hiss',
      kind: 'hiss',
      polyphony: 3,
      params: {},
      graph: () => noise(),
    });
    const seeds: (number | undefined)[] = [];
    const renderer = {
      createVoice: async (_graph: unknown, options?: { seed?: number }) => {
        seeds.push(options?.seed);
        return { node: { connect() {}, disconnect() {} } } as never;
      },
    };
    await material.bind(renderer, undefined, { seed: 100 });
    expect(seeds).toEqual([100, 101, 102]);
    seeds.length = 0;
    await material.bind(renderer);
    expect(seeds).toEqual([undefined, undefined, undefined]);
  });
});
