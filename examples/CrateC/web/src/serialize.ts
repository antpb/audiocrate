/**
 * A graph as the CrateC kernel takes it: JSON for the structure, sample data
 * as Float32Arrays beside it.
 *
 * `serializeGraph` writes a sample box or wavetable as a JSON array of
 * numbers, which is right for a document and wrong for a live hand-off: the
 * drum's sixteen pads are megabytes of text to write and parse again, and a
 * shared subtree written out once per reader multiplies that past what a
 * JavaScript string can hold. So each table becomes `{ "ext": n }` (CrateC's
 * `crate_build_set_external_tables`), and shared nodes are written once
 * (format 2, `shareSerializedGraph`).
 */
import { serializeGraph, shareSerializedGraph, type ASLGraphDescriptor } from '../../../../src/index';

type Node = ASLGraphDescriptor['output'];

export interface KernelGraph {
  json: string;
  tables: Float32Array[];
}

export function graphForKernel(graph: ASLGraphDescriptor): KernelGraph {
  const tables: Float32Array[] = [];
  const index = new Map<Float32Array, number>();
  const ref = (table: Float32Array) => {
    let i = index.get(table);
    if (i === undefined) {
      i = tables.length;
      tables.push(table);
      index.set(table, i);
    }
    return { ext: i };
  };
  const clones = new Map<Node, Node>();
  const clone = (node: Node): Node => {
    const done = clones.get(node);
    if (done) return done;
    const params: Record<string, unknown> = { ...node.params };
    if (params.table instanceof Float32Array) params.table = ref(params.table);
    const box = params.box as { samples?: unknown } | undefined;
    if (box && box.samples instanceof Float32Array) params.box = { ...box, samples: ref(box.samples) };
    const inputs: Record<string, Node> = {};
    const out: Node = { ...node, params, inputs, ...(node.list ? { list: [] as Node[] } : {}) } as Node;
    clones.set(node, out);
    for (const [key, child] of Object.entries(node.inputs)) inputs[key] = clone(child);
    if (node.list) (out as { list: Node[] }).list.push(...node.list.map(clone));
    return out;
  };
  const cloneGraph = (g: ASLGraphDescriptor): ASLGraphDescriptor => ({
    ...g,
    output: clone(g.output),
    ...(g.sends ? { sends: g.sends.map(clone) } : {}),
    ...(g.bus ? { bus: cloneGraph(g.bus) } : {}),
  });
  return { json: JSON.stringify(shareSerializedGraph(serializeGraph(cloneGraph(graph)))), tables };
}
