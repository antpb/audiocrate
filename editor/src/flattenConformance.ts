/**
 * The cross-language contract for `flattenPatch`.
 *
 * A native patcher has to lower a patch to one ASL graph, and that lowering
 * is the one piece of crate that a host cannot get from a `crate.plugin`:
 * the compiled graph in a plugin document is the *output* of flatten, so a
 * host that edits patches must do the lowering itself. Two implementations
 * of it is exactly the arrangement `asl-conformance` exists to police, so
 * this fixture polices this one the same way.
 *
 * ## What is compared, and why it is not the JSON
 *
 * Node ids come off a global counter in each language, so the two sides
 * cannot be compared by their serialized documents even when they are
 * identical graphs. The fixture carries a **canonical form** instead: nodes
 * renumbered in first-visit order, inputs walked in sorted key order, shared
 * subgraphs appearing once in a flat list and referenced by number.
 *
 * That last part is the reason to canonicalise rather than expand. A graph
 * is a DAG; expanding it compares a tree and cannot tell a shared filter from
 * two identical filters, which is the difference between one delay line and
 * two fed the same signal. In the flat form, sharing is the node count.
 *
 * ## What the cases are for
 *
 * Each case exists to fail if one rule of the lowering is wrong, and several
 * of them were chosen because the obvious patch cannot fail. A patch whose
 * gains are all 1 and whose cables are all audio proves nothing about CV
 * mapping, polarity, or address order.
 */
import { DEFAULT_PATCH_IO, detectPatchRole, flattenPatch, type PatchDocument } from '../../src/index';
import { compileMaterial, type SerializedASLNode } from '../../src/patcher/compiledPlugin';
import type { ParamDescriptor } from '../../src/graph/param';
import { resolveKind } from './pluginDoc';

export const FLATTEN_CONFORMANCE_VERSION = 1;

export interface CanonicalNode {
  id: number;
  kind: string;
  params: Record<string, unknown>;
  /** Input key to canonical node id, keys sorted. */
  inputs: Record<string, number>;
  list?: number[];
}

export interface CanonicalGraph {
  inputs: string[];
  channels?: number;
  output: number;
  nodes: CanonicalNode[];
}

export interface FlattenExpectation {
  name: string;
  role: 'insert' | 'instrument';
  polyphony?: number;
  ports: string[];
  params: Record<string, ParamDescriptor>;
  graph: CanonicalGraph;
}

export interface FlattenCase {
  name: string;
  /** What this case fails on, so a red test says which rule broke. */
  proves: string;
  patch: PatchDocument;
  role?: 'insert' | 'instrument';
  expected: FlattenExpectation;
}

export interface FlattenConformanceFixture {
  note: string;
  version: number;
  io: typeof DEFAULT_PATCH_IO;
  cases: FlattenCase[];
}

/**
 * Renumbers a serialized graph into first-visit order over sorted input keys.
 *
 * Sharing is preserved by id: the document writes a shared subgraph more than
 * once with the same id each time, so the memo keyed on the original id is
 * what collapses the copies back into one canonical node.
 */
export function canonicalGraph(graph: {
  inputs: readonly string[];
  output: SerializedASLNode;
  channels?: number;
}): CanonicalGraph {
  const nodes: CanonicalNode[] = [];
  const seen = new Map<number, number>();

  const visit = (node: SerializedASLNode): number => {
    const already = seen.get(node.id);
    if (already !== undefined) return already;
    // Reserve the slot before walking children, so a canonical id is the
    // order a node was first reached rather than the order it finished.
    const id = nodes.length;
    seen.set(node.id, id);
    const placeholder: CanonicalNode = { id, kind: node.kind, params: node.params, inputs: {} };
    nodes.push(placeholder);
    const inputs: Record<string, number> = {};
    for (const key of Object.keys(node.inputs).sort()) {
      inputs[key] = visit(node.inputs[key]!);
    }
    placeholder.inputs = inputs;
    if (node.list) placeholder.list = node.list.map(visit);
    return id;
  };

  const output = visit(graph.output);
  return {
    inputs: [...graph.inputs],
    ...(graph.channels ? { channels: graph.channels } : {}),
    output,
    nodes,
  };
}

function node(id: string, kind: string, params?: Record<string, number>) {
  return params ? { id, kind, params } : { id, kind };
}

function wire(source: string, sourceOutput: string, target: string, targetInput: string) {
  return { source, sourceOutput, target, targetInput };
}

const MASTER = DEFAULT_PATCH_IO.master;
const LINE = DEFAULT_PATCH_IO.line;
const KEYBOARD = DEFAULT_PATCH_IO.keyboard;
const TRANSPORT = DEFAULT_PATCH_IO.transport;

interface CaseSpec {
  name: string;
  proves: string;
  patch: PatchDocument;
  role?: 'insert' | 'instrument';
}

const CASES: CaseSpec[] = [
  {
    name: 'line into gain into master',
    proves:
      'an audio cable replaces the downstream port node, and a Line cable becomes the hosted ' +
      "insert's own `input` port rather than a node reference",
    patch: {
      nodes: [node('src', LINE), node('g', 'gain', { gain: 0.4 }), node('out', MASTER)],
      connections: [wire('src', 'audio', 'g', 'input'), wire('g', 'audio', 'out', 'input')],
    },
  },
  {
    name: 'stacked cables into one inlet mix',
    proves:
      'two cables into the same inlet sum through a `mix` node rather than the second ' +
      'replacing the first. A case with one cable per inlet cannot see this.',
    patch: {
      nodes: [
        node('src', LINE),
        node('a', 'lowpass', { cutoff: 400, q: 0.8 }),
        node('b', 'highpass', { cutoff: 2000, q: 0.8 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'a', 'input'),
        wire('src', 'audio', 'b', 'input'),
        wire('a', 'audio', 'out', 'input'),
        wire('b', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'bipolar CV into a param',
    proves:
      'an LFO into a param becomes a `range` mapped onto that param’s declared min and max, ' +
      'and the param it replaced is no longer published. Non-default bounds, so a wrong ' +
      'min or max is a different number rather than the same one.',
    patch: {
      nodes: [
        node('src', LINE),
        node('lfo', 'lfo', { rate: 2, amount: 1 }),
        node('lp', 'lowpass', { cutoff: 900, q: 1.4 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'lp', 'input'),
        wire('lfo', 'cv', 'lp', 'cutoff'),
        wire('lp', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'unipolar CV into a param lifts first',
    proves:
      'a unipolar source (ADSR) is lifted 0..1 onto -1..1 before the range map, so 0 is the ' +
      'param minimum. A bipolar source skips that lift, and the two differ by two nodes.',
    patch: {
      nodes: [
        node('src', LINE),
        node('env', 'adsr', { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3, amount: 1 }),
        node('lp', 'lowpass', { cutoff: 900, q: 1.4 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'lp', 'input'),
        wire('env', 'cv', 'lp', 'cutoff'),
        wire('lp', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'two gains do not collide',
    proves:
      'every surviving param is republished as `{nodeId}_{name}` with a fresh sequential ' +
      'address in topological order. Two nodes of one kind is the only arrangement where a ' +
      'missing prefix shows up.',
    patch: {
      nodes: [
        node('src', LINE),
        node('one', 'gain', { gain: 0.25 }),
        node('two', 'gain', { gain: 1.75 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'one', 'input'),
        wire('one', 'audio', 'two', 'input'),
        wire('two', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'transport outlet into a param is absolute',
    proves:
      'a Transport outlet lands on a param in real units with no `range` around it, unlike ' +
      'every other CV source, and the Transport node publishes none of its own knobs',
    patch: {
      nodes: [
        node('src', LINE),
        node('t', TRANSPORT, { bpm: 132, beatsPerBar: 4, beatUnit: 4 }),
        node('d', 'delay', { timeSec: 0.3, feedback: 0.4, mix: 0.5 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'd', 'input'),
        wire('t', 'bpm', 'd', 'feedback'),
        wire('d', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'transport pulse into master',
    proves:
      'a Transport outlet can be an output tap in its own right, mixed with the audio ones, ' +
      'and `pulse` lowers to a transport node rather than to a param read',
    patch: {
      nodes: [
        node('t', TRANSPORT, { bpm: 120, beatsPerBar: 4, beatUnit: 4 }),
        node('src', LINE),
        node('g', 'gain', { gain: 0.6 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'g', 'input'),
        wire('g', 'audio', 'out', 'input'),
        wire('t', 'pulse', 'out', 'input'),
      ],
    },
  },
  {
    name: 'analysis outlet into a param',
    proves:
      'a tuner’s `cents` outlet becomes a `pitch` node reading the analysed audio, not the ' +
      'audio itself, and it lands absolute the way a transport outlet does',
    patch: {
      nodes: [
        node('src', LINE),
        node('tune', 'tuner'),
        node('lp', 'lowpass', { cutoff: 800, q: 0.9 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'tune', 'input'),
        wire('src', 'audio', 'lp', 'input'),
        wire('tune', 'cents', 'lp', 'q'),
        wire('lp', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'analysis cv outlet is a scaled pitch',
    proves:
      'the `cv` outlet is `(midi - 69) / 12` rather than the midi number, which is three ' +
      'nodes where `note` is one',
    patch: {
      nodes: [
        node('src', LINE),
        node('an', 'analyzer'),
        node('g', 'gain', { gain: 0.8 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'an', 'input'),
        wire('src', 'audio', 'g', 'input'),
        wire('an', 'cv', 'g', 'gain'),
        wire('g', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'looper pulse outlet',
    proves:
      'a looper `start` outlet is the same looper node with its `field` swapped, sharing the ' +
      'looper’s inputs, rather than a second looper. Swapping start for end must change the ' +
      'canonical form.',
    patch: {
      nodes: [
        node('src', LINE),
        node('loop', 'looper', { record: 0, play: 1, length: 4, mix: 1 }),
        node('g', 'gain', { gain: 0.5 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'loop', 'input'),
        wire('loop', 'audio', 'g', 'input'),
        wire('loop', 'start', 'g', 'gain'),
        wire('g', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'keyboard makes it an instrument',
    proves:
      'a keyboard cable into a note jack detects the instrument role, contributes no node to ' +
      'the graph, and leaves the inner `note` and `gate` params in place to resolve per voice',
    patch: {
      nodes: [
        node('keys', KEYBOARD),
        node('osc', 'oscillator', { type: 1, gain: 0.3, width: 0.5, octave: 0, detune: 0 }),
        node('out', MASTER),
      ],
      connections: [
        wire('keys', 'cv', 'osc', 'note'),
        wire('keys', 'gate', 'osc', 'gate'),
        wire('osc', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'polyphony is the largest inner voice count',
    proves:
      'an instrument’s voice count is the maximum over its materials, not the first one’s. ' +
      'The monophonic Tone is deliberately first in the document, so a port that takes the ' +
      'head of the list instead of the maximum answers 1.',
    patch: {
      nodes: [
        node('keys', KEYBOARD),
        node('tone', 'tone', { freq: 220, gain: 0.2 }),
        node('voice', 'SynthVoice'),
        node('mix', 'audiomix'),
        node('out', MASTER),
      ],
      connections: [
        wire('keys', 'cv', 'voice', 'note'),
        wire('keys', 'gate', 'voice', 'gate'),
        wire('tone', 'audio', 'mix', 'input'),
        wire('voice', 'audio', 'mix', 'input'),
        wire('mix', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'an instrument of monophonic materials is one voice',
    proves:
      'the voice count falls out of the materials rather than out of the role. Every other ' +
      'instrument case here lands on 8, so a port that hardcodes 8 for instruments passes ' +
      'them all and fails this one.',
    role: 'instrument',
    patch: {
      nodes: [
        node('src', LINE),
        node('lp', 'lowpass', { cutoff: 640, q: 1.2 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'lp', 'input'),
        wire('lp', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'sidechain is a second audio port',
    proves:
      'a cable into an aux audio inlet replaces that named port and not the main one, so a ' +
      'compressor’s sidechain does not become its input',
    patch: {
      nodes: [
        node('src', LINE),
        node('key', 'oscillator', { type: 0, gain: 0.5, width: 0.5, octave: 0, detune: 0 }),
        node('comp', 'sidechaincomp'),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'comp', 'input'),
        wire('key', 'audio', 'comp', 'sidechain'),
        wire('comp', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'a fan-out is shared, not duplicated',
    proves:
      'one outlet feeding two nodes appears once in the flattened graph. Expanded as a tree ' +
      'this case is indistinguishable from two copies of the filter.',
    patch: {
      nodes: [
        node('src', LINE),
        node('lp', 'lowpass', { cutoff: 700, q: 1.1 }),
        node('l', 'gain', { gain: 0.3 }),
        node('r', 'gain', { gain: 0.9 }),
        node('out', MASTER),
      ],
      connections: [
        wire('src', 'audio', 'lp', 'input'),
        wire('lp', 'audio', 'l', 'input'),
        wire('lp', 'audio', 'r', 'input'),
        wire('l', 'audio', 'out', 'input'),
        wire('r', 'audio', 'out', 'input'),
      ],
    },
  },
  {
    name: 'evaluation order is topological, not document order',
    proves:
      'addresses are assigned in dependency order. The nodes are deliberately listed backwards, ' +
      'so a port that iterates the document instead of sorting gets different addresses.',
    patch: {
      nodes: [
        node('out', MASTER),
        node('last', 'gain', { gain: 0.2 }),
        node('mid', 'lowpass', { cutoff: 1200, q: 0.6 }),
        node('first', 'highpass', { cutoff: 120, q: 0.8 }),
        node('src', LINE),
      ],
      connections: [
        wire('src', 'audio', 'first', 'input'),
        wire('first', 'audio', 'mid', 'input'),
        wire('mid', 'audio', 'last', 'input'),
        wire('last', 'audio', 'out', 'input'),
      ],
    },
  },
];

export function buildFlattenConformanceFixture(): FlattenConformanceFixture {
  const cases: FlattenCase[] = CASES.map((spec) => {
    const material = flattenPatch(spec.patch, {
      resolve: resolveKind,
      name: spec.name,
      kind: spec.name,
      role: spec.role,
    });
    const role = spec.role ?? detectPatchRole(spec.patch);
    // The flattened material's own voice count, not the document's.
    // `compileMaterial(material, role)` omits the field entirely, which would
    // leave the polyphony case asserting nothing: a port that always answered
    // 1 would pass it.
    const compiled = compileMaterial(material, role, material.polyphony);
    return {
      name: spec.name,
      proves: spec.proves,
      patch: spec.patch,
      ...(spec.role ? { role: spec.role } : {}),
      expected: {
        name: compiled.name,
        role: compiled.role,
        ...(compiled.polyphony != null ? { polyphony: compiled.polyphony } : {}),
        ports: [...compiled.ports],
        params: compiled.params,
        graph: canonicalGraph(compiled.graph),
      },
    };
  });

  return {
    note:
      'Generated by editor/scripts/emit-flatten-fixtures.ts. ' +
      'Do not edit by hand: run `npm run fixtures:flatten`.',
    version: FLATTEN_CONFORMANCE_VERSION,
    io: DEFAULT_PATCH_IO,
    cases,
  };
}
