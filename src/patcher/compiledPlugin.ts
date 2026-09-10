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
import type { Material } from '../graph/Material';

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
  };
}

/** The compiled form of an already-built Material. */
export function compileMaterial(
  material: Material,
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
  resolve: (kind: string) => Material | null | undefined;
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
