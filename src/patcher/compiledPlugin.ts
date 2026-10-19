/**
 * The compiled half of a `crate.plugin`: the flattened graph and the
 * parameter schema, as plain JSON.
 *
 * A `crate.plugin` document is a *patch*: nodes and connections. The ASL
 * graph an interpreter actually runs is produced from it by `flattenPatch`,
 * in JavaScript, at `create()`. That is fine for a browser and impossible
 * for a native host, which would otherwise need a second implementation of
 * node-to-graph lowering kept in step with this one forever.
 *
 * So export writes the compiled artifact next to the patch it came from.
 * The patch stays the editable source of truth and is what a patcher reopens;
 * `compiled` is what a host without a patcher loads. Nothing reads both.
 *
 * Additive on purpose: `compiled` is optional, and every document written
 * before this existed still parses and still works through `flattenPatch`.
 */
import type { ASLGraphDescriptor } from '../asl/graph';
import type { ASLNode } from '../asl/types';
import type { ParamDescriptor } from '../graph/param';
import { flattenPatch, type PatchIoKinds } from './flattenPatch';
import type { CratePluginDocument } from './cratePlugin';
import type { AudioMaterial } from '../graph/AudioMaterial';

/**
 * A graph node with every typed array turned into a plain one, so it
 * survives `JSON.stringify` and arrives somewhere else as the same numbers.
 *
 * Shared subgraphs are written out more than once, because JSON has no way
 * to say "the same node again". Every copy keeps its `id`, and a decoder is
 * expected to re-share by id the way `compileVoice` already does. A decoder
 * that misses that gives one filter two delay lines, which sounds almost
 * right, which is the worst way for it to be wrong.
 */
export interface SerializedASLNode {
  readonly id: number;
  readonly kind: string;
  readonly params: Record<string, unknown>;
  readonly inputs: Record<string, SerializedASLNode>;
  readonly list?: readonly SerializedASLNode[];
}

export interface SerializedGraph {
  readonly inputs: readonly string[];
  readonly output: SerializedASLNode;
  readonly channels?: 1 | 2;
  /** Parameters whose host changes glide. See `ASLGraphDescriptor.smooth`. */
  readonly smooth?: readonly string[];
  /**
   * A split instrument's voice outputs (`ASLGraphDescriptor.sends`). Every
   * one is a node inside `output`, written again here (by id, so a decoder
   * finds the one it already built).
   */
  readonly sends?: readonly SerializedASLNode[];
  /** What runs once on the voices' summed sends. See `ASLGraphDescriptor.bus`. */
  readonly bus?: SerializedGraph;
}

/** What a host that cannot run `flattenPatch` needs, and nothing more. */
export interface CompiledMaterialDocument {
  readonly graph: SerializedGraph;
  /**
   * The published parameter schema. A descriptor's `address` is the
   * `AUParameterAddress` a native host builds its parameter tree from, which
   * is why it travels with the graph rather than being re-derived.
   */
  readonly params: Record<string, ParamDescriptor>;
  readonly name: string;
  readonly role: 'insert' | 'instrument';
  readonly polyphony?: number;
  /** Live audio inputs the graph reads, sorted, `input` included. */
  readonly ports: readonly string[];
}

function serializeParam(value: unknown): unknown {
  if (value instanceof Float32Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(serializeParam);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serializeParam(inner);
    }
    return out;
  }
  return value;
}

export function serializeNode(node: ASLNode): SerializedASLNode {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.params)) params[key] = serializeParam(value);
  const inputs: Record<string, SerializedASLNode> = {};
  for (const [key, child] of Object.entries(node.inputs)) inputs[key] = serializeNode(child);
  const out: SerializedASLNode = { id: node.id, kind: node.kind, params, inputs };
  if (node.list) return { ...out, list: node.list.map(serializeNode) };
  return out;
}

export function serializeGraph(graph: ASLGraphDescriptor): SerializedGraph {
  return {
    inputs: [...graph.inputs],
    output: serializeNode(graph.output),
    ...(graph.channels ? { channels: graph.channels } : {}),
    ...(graph.smooth ? { smooth: [...graph.smooth] } : {}),
    ...(graph.sends ? { sends: graph.sends.map(serializeNode) } : {}),
    ...(graph.bus ? { bus: serializeGraph(graph.bus) } : {}),
  };
}

/**
 * A node written for the second time, in format 2: "the node with this id,
 * again". See `docs/format.md`.
 */
export interface SerializedNodeRef {
  readonly ref: number;
}

/** A graph as format 2 writes it: every node in full once, then by reference. */
export interface SharedSerializedGraph {
  readonly inputs: readonly string[];
  readonly output: SharedSerializedNode;
  readonly channels?: 1 | 2;
  readonly smooth?: readonly string[];
  /** Always references: every send is defined inside `output`. */
  readonly sends?: readonly SerializedNodeRef[];
  readonly bus?: SharedSerializedGraph;
}

export interface SharedSerializedNode {
  readonly id: number;
  readonly kind: string;
  readonly params: Record<string, unknown>;
  readonly inputs: Record<string, SharedSerializedNode | SerializedNodeRef>;
  readonly list?: readonly (SharedSerializedNode | SerializedNodeRef)[];
}

function isRef(node: unknown): node is SerializedNodeRef {
  return !!node && typeof node === 'object' && 'ref' in node && !('kind' in node);
}

/**
 * Writes each node in full the first time it is reached and as `{ ref: id }`
 * after that, depth first in key order, so a definition always precedes its
 * references in the text. Works on a graph that was already expanded by
 * `serializeGraph`, because every copy of a shared node kept its id.
 *
 * On the patches XR Publisher ships this writes a quarter of the nodes:
 * `ambient-bloom` has 108 distinct nodes written 433 times.
 */
export function shareSerializedGraph(graph: SerializedGraph | SharedSerializedGraph): SharedSerializedGraph {
  const written = new Set<number>();
  const visit = (node: SerializedASLNode | SharedSerializedNode | SerializedNodeRef): SharedSerializedNode | SerializedNodeRef => {
    if (isRef(node)) return node;
    if (written.has(node.id)) return { ref: node.id };
    written.add(node.id);
    const inputs: Record<string, SharedSerializedNode | SerializedNodeRef> = {};
    for (const [key, child] of Object.entries(node.inputs)) inputs[key] = visit(child);
    const out: SharedSerializedNode = { id: node.id, kind: node.kind, params: node.params, inputs };
    return node.list ? { ...out, list: node.list.map(visit) } : out;
  };
  const output = visit(graph.output);
  if (isRef(output)) throw new Error('crate.plugin: a graph output cannot be a reference');
  return {
    inputs: [...graph.inputs],
    output,
    ...(graph.channels ? { channels: graph.channels } : {}),
    ...(graph.smooth ? { smooth: [...graph.smooth] } : {}),
    ...(graph.sends ? { sends: graph.sends.map((send) => ({ ref: isRef(send) ? send.ref : send.id })) } : {}),
    ...(graph.bus ? { bus: shareSerializedGraph(graph.bus) } : {}),
  };
}

/**
 * Reads a graph in either format into the shape `compileVoice` takes: nodes
 * shared by id become one object reached from several places, which is what a
 * graph built in code already is. A format 1 file's repeated copies are folded
 * the same way, so it costs one object per node in memory rather than one per
 * appearance.
 *
 * Refuses a reference to an id with no definition, and a node that is its own
 * ancestor, rather than building something the interpreter would have to
 * guess about.
 */
export function inflateSerializedGraph(graph: SerializedGraph | SharedSerializedGraph): SerializedGraph {
  const defined = new Map<number, SharedSerializedNode>();
  const collect = (node: SharedSerializedNode | SerializedNodeRef | SerializedASLNode): void => {
    if (isRef(node)) return;
    if (!defined.has(node.id)) defined.set(node.id, node);
    for (const child of Object.values(node.inputs)) collect(child);
    for (const child of node.list ?? []) collect(child);
  };
  collect(graph.output);

  const built = new Map<number, SerializedASLNode>();
  const building = new Set<number>();
  const build = (node: SharedSerializedNode | SerializedNodeRef | SerializedASLNode): SerializedASLNode => {
    const id = isRef(node) ? node.ref : node.id;
    const done = built.get(id);
    if (done) return done;
    const source = defined.get(id);
    if (!source) throw new Error(`crate.plugin: the graph refers to node ${id}, which it never defines`);
    if (building.has(id)) throw new Error(`crate.plugin: node ${id} is its own input`);
    building.add(id);
    const inputs: Record<string, SerializedASLNode> = {};
    for (const [key, child] of Object.entries(source.inputs)) inputs[key] = build(child);
    const out: SerializedASLNode = source.list
      ? { id, kind: source.kind, params: source.params, inputs, list: source.list.map(build) }
      : { id, kind: source.kind, params: source.params, inputs };
    building.delete(id);
    built.set(id, out);
    return out;
  };
  const output = build(graph.output);
  return {
    inputs: [...graph.inputs],
    output,
    ...(graph.channels ? { channels: graph.channels } : {}),
    ...(graph.smooth ? { smooth: [...graph.smooth] } : {}),
    ...(graph.sends ? { sends: graph.sends.map(build) } : {}),
    ...(graph.bus ? { bus: inflateSerializedGraph(graph.bus) } : {}),
  };
}

/**
 * The same graph with ids renumbered 1..n, keeping their relative order.
 *
 * Ids come off a process-wide counter, so the same material serializes with
 * different ids depending on what was built before it, and two exports of one
 * patch diff on every line. Renumbering fixes that. Nothing about the sound
 * depends on the numbers (`randomRanks` in compile.ts reads the shape), so any
 * renumbering is safe; keeping the order just keeps a diff against the
 * original readable.
 */
export function canonicalizeSerializedGraph(graph: SerializedGraph): SerializedGraph {
  const ids = new Set<number>();
  const collect = (node: SerializedASLNode): void => {
    ids.add(node.id);
    for (const child of Object.values(node.inputs)) collect(child);
    for (const child of node.list ?? []) collect(child);
  };
  collect(graph.output);
  const renumber = new Map([...ids].sort((a, b) => a - b).map((id, index) => [id, index + 1]));
  const memo = new Map<number, SerializedASLNode>();
  const visit = (node: SerializedASLNode): SerializedASLNode => {
    const done = memo.get(node.id);
    if (done) return done;
    const inputs: Record<string, SerializedASLNode> = {};
    for (const [key, child] of Object.entries(node.inputs)) inputs[key] = visit(child);
    const id = renumber.get(node.id)!;
    const out: SerializedASLNode = node.list
      ? { id, kind: node.kind, params: node.params, inputs, list: node.list.map(visit) }
      : { id, kind: node.kind, params: node.params, inputs };
    memo.set(node.id, out);
    return out;
  };
  const output = visit(graph.output);
  return {
    inputs: [...graph.inputs],
    output,
    ...(graph.channels ? { channels: graph.channels } : {}),
    ...(graph.smooth ? { smooth: [...graph.smooth] } : {}),
    ...(graph.sends ? { sends: graph.sends.map(visit) } : {}),
    ...(graph.bus ? { bus: canonicalizeSerializedGraph(graph.bus) } : {}),
  };
}

/** The compiled form of an already-built AudioMaterial. */
export function compileMaterial(
  material: AudioMaterial,
  role: 'insert' | 'instrument',
  polyphony?: number,
): CompiledMaterialDocument {
  return {
    graph: serializeGraph(material.graph),
    params: material.params,
    name: material.name,
    role,
    ...(polyphony != null ? { polyphony } : {}),
    ports: material.audioInputs,
  };
}

export interface CompileCratePluginOptions {
  resolve: (kind: string) => AudioMaterial | null | undefined;
  io?: Partial<PatchIoKinds>;
}

/**
 * Flattens a plugin document's patch and returns the compiled artifact.
 * Same call `pluginFromDocument`'s `create()` makes, so the graph a native
 * host runs is by construction the graph a browser runs.
 */
export function compileCratePlugin(
  doc: CratePluginDocument,
  options: CompileCratePluginOptions,
): CompiledMaterialDocument {
  const material = flattenPatch(doc.patch, {
    resolve: options.resolve,
    io: options.io,
    name: doc.label,
    kind: doc.id,
    role: doc.role,
    polyphony: doc.polyphony,
    voiceStealing: doc.steal,
  });
  return compileMaterial(material, doc.role, doc.polyphony);
}
