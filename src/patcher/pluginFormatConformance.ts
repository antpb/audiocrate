/**
 * The `crate.plugin` format conformance fixture, as a value.
 *
 * Format 2 writes a shared node once and refers to it after that. Every reader
 * of a `compiled` graph has to put the references back, and the failure this
 * guards against is the quiet one: a reader that resolves a reference to a
 * *copy* rather than to the node gives one filter two delay lines, which
 * compiles, plays, and sounds almost right.
 *
 * Each case is one real material written both ways, as the exact text a file
 * would hold, plus what JavaScript renders from it. A reader passes when both
 * texts decode, the format 2 graph is no larger than the format 1 graph once
 * resolved, and both render what JavaScript rendered. The materials are the
 * ones that share the most (`parametricEq` writes 153 nodes for 33), plus
 * a stereo per-channel graph and an instrument.
 *
 * The input is a triangle computed from integers, not a sine, so it is the
 * same float in every language and the render comparison measures the reader
 * rather than two libms.
 */
import { compileVoice } from '../asl/compile';
import type { ASLGraphDescriptor } from '../asl/graph';
import type { AudioMaterial } from '../graph/AudioMaterial';
import {
  autoPanMaterial,
  gateMaterial,
  parametricEqMaterial,
  reverbMaterial,
  stereoPanMaterial,
  synthVoiceMaterial,
} from '../materials';
import { oscillatorMaterial } from '../materials/sources';
import { canonicalizeSerializedGraph, compileMaterial } from './compiledPlugin';
import { flattenPatch } from './flattenPatch';
import { cratePluginDocument, stringifyCratePlugin } from './cratePlugin';

/**
 * Bumped when the shape changes, not when a material does.
 *
 * 1: v1 and v2 texts, params, rendered left and right.
 */
export const PLUGIN_FORMAT_FIXTURE_VERSION = 1;

export const PLUGIN_FORMAT_FRAMES = 128;
export const PLUGIN_FORMAT_BLOCKS = 4;
export const PLUGIN_FORMAT_SAMPLE_RATE = 48000;

export interface PluginFormatCase {
  name: string;
  role: 'insert' | 'instrument';
  /** The file as format 1 writes it. */
  v1: string;
  /** The same document as format 2 writes it. */
  v2: string;
  /**
   * Node appearances written in each, a `{ ref }` counting as one, so a
   * reader can see the sharing was real.
   */
  v1Nodes: number;
  v2Nodes: number;
  /** Distinct node ids, which a resolved graph must have exactly. */
  uniqueNodes: number;
  /** Applied with the opening note on. */
  params: Record<string, number>;
  /** Every rendered sample, all blocks, left then right. */
  left: number[];
  right: number[] | null;
}

export interface PluginFormatFixture {
  version: number;
  sampleRate: number;
  frames: number;
  blocks: number;
  /** One block of input, both channels (the right is the left inverted). */
  input: number[];
  cases: PluginFormatCase[];
  stamp: string;
}

const MATERIALS: [string, AudioMaterial, 'insert' | 'instrument'][] = [
  ['parametric eq', parametricEqMaterial, 'insert'],
  ['auto pan', autoPanMaterial, 'insert'],
  ['gate', gateMaterial, 'insert'],
  ['stereo pan', stereoPanMaterial, 'insert'],
  ['reverb', reverbMaterial, 'insert'],
  ['synth voice', synthVoiceMaterial, 'instrument'],
  // Format 3: an oscillator voice into a reverb that runs once on the sum.
  // A reader that ignores `bus` renders the dry oscillator and fails here.
  ['split voice', splitVoice(), 'instrument'],
];

function splitVoice(): AudioMaterial {
  return flattenPatch(
    {
      nodes: [
        { id: 'keys', kind: 'keyboard' },
        { id: 'osc', kind: 'oscillator', params: { gain: 0.4 } },
        { id: 'rev', kind: 'reverb', params: { mix: 0.5 } },
        { id: 'out', kind: 'master' },
      ],
      connections: [
        { source: 'keys', sourceOutput: 'cv', target: 'osc', targetInput: 'note' },
        { source: 'keys', sourceOutput: 'gate', target: 'osc', targetInput: 'gate' },
        { source: 'osc', sourceOutput: 'audio', target: 'rev', targetInput: 'input' },
        { source: 'rev', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
      ],
    },
    {
      resolve: (kind) => (kind === 'oscillator' ? oscillatorMaterial : kind === 'reverb' ? reverbMaterial : null),
      role: 'instrument',
      name: 'split voice',
    },
  );
}

/** A triangle in [-0.5, 0.5] with period 64, exact in Float32 in any language. */
export function pluginFormatInput(): Float32Array {
  const out = new Float32Array(PLUGIN_FORMAT_FRAMES);
  for (let i = 0; i < out.length; i++) {
    const phase = i % 64;
    out[i] = (phase < 32 ? phase - 16 : 48 - phase) / 32;
  }
  return out;
}

function countNodes(text: string): { written: number; unique: number } {
  const graph = (JSON.parse(text) as { compiled: { graph: { output: unknown } } }).compiled.graph;
  const ids = new Set<number>();
  let written = 0;
  const walk = (node: { id?: number; ref?: number; inputs?: object; list?: unknown[] }): void => {
    written += 1;
    if (node.ref !== undefined) return;
    ids.add(node.id!);
    for (const child of Object.values(node.inputs ?? {})) walk(child);
    for (const child of node.list ?? []) walk(child as typeof node);
  };
  walk(graph.output as never);
  return { written, unique: ids.size };
}

function render(graph: ASLGraphDescriptor, role: 'insert' | 'instrument', params: Record<string, number>) {
  const voice = compileVoice(graph);
  const state = voice.createState();
  voice.noteOn(state, params);
  const input = pluginFormatInput();
  const inputR = input.map((x) => -x);
  const out = new Float32Array(PLUGIN_FORMAT_FRAMES);
  const outR = new Float32Array(PLUGIN_FORMAT_FRAMES);
  const left: number[] = [];
  const right: number[] = [];
  let stereo = false;
  for (let b = 0; b < PLUGIN_FORMAT_BLOCKS; b++) {
    stereo = voice.renderBlock(state, PLUGIN_FORMAT_SAMPLE_RATE, out, role === 'insert' ? input : undefined, {
      inputR: role === 'insert' ? inputR : undefined,
      outputR: outR,
    });
    left.push(...out);
    right.push(...outR);
  }
  return { left, right: stereo ? right : null };
}

export function pluginFormatStamp(fixture: Omit<PluginFormatFixture, 'stamp'> & { stamp?: string }): string {
  const body = JSON.stringify([fixture.version, fixture.sampleRate, fixture.frames, fixture.blocks, fixture.input, fixture.cases]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildPluginFormatFixture(): PluginFormatFixture {
  const cases = MATERIALS.map(([name, material, role]): PluginFormatCase => {
    const doc = cratePluginDocument({
      label: name,
      role,
      // The patch half is not what this fixture is about; one node keeps the
      // document valid for readers that check it is there.
      patch: { nodes: [{ id: 'n1', kind: material.kind }], connections: [] },
    });
    // Canonical ids, or the text depends on what else this process built
    // first and the fixture is stale in one runner and fresh in another.
    const compiled = compileMaterial(material, role);
    doc.compiled = { ...compiled, graph: canonicalizeSerializedGraph(compiled.graph) };
    const v1 = stringifyCratePlugin(doc);
    const v2 = stringifyCratePlugin(doc, { shareNodes: true });
    const params: Record<string, number> = { ...material.snapshotParams() };
    if (role === 'instrument') Object.assign(params, { note: 57, velocity: 0.9 });
    const one = countNodes(v1);
    const two = countNodes(v2);
    return {
      name,
      role,
      v1,
      v2,
      v1Nodes: one.written,
      v2Nodes: two.written,
      uniqueNodes: one.unique,
      params,
      // Rendered from the canonical graph, which is what the file holds.
      ...render(doc.compiled.graph as unknown as ASLGraphDescriptor, role, params),
    };
  });
  const fixture: Omit<PluginFormatFixture, 'stamp'> = {
    version: PLUGIN_FORMAT_FIXTURE_VERSION,
    sampleRate: PLUGIN_FORMAT_SAMPLE_RATE,
    frames: PLUGIN_FORMAT_FRAMES,
    blocks: PLUGIN_FORMAT_BLOCKS,
    input: Array.from(pluginFormatInput()),
    cases,
  };
  return { ...fixture, stamp: pluginFormatStamp(fixture) };
}
