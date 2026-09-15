/**
 * The palette a native patcher needs, built from this editor's own catalog.
 *
 * Crate core has no "list every AudioMaterial" API on purpose, so the palette
 * is an editor concept. The Swift patcher is a second editor, and the only
 * way for the two to offer the same materials with the same jacks and the
 * same parameter ranges is for one of them to be generated from the other.
 * This builds that value; `scripts/emit-material-catalog.ts` writes it.
 *
 * What travels is each material's **built ASL graph**, serialized. A graph is
 * built once in `AudioMaterial`'s constructor and does not depend on
 * parameter values (`setParam` writes `paramValues`, never the graph), so one
 * serialized graph per kind plus a value map is the whole of what a native
 * `flattenPatch` needs to splice. Porting 109 material *builders* to Swift
 * would be the other way to get here, and it would have to be kept in step by
 * hand forever.
 *
 * Kernels are emitted with a refusal rather than omitted. They are in the web
 * palette, so leaving them out silently would make the two palettes differ
 * for a reason a native user cannot see. Carrying the reason lets the native
 * palette show them and say why they will not run there.
 */
import { DEFAULT_PATCH_IO, isAnalysisKind, isLooperKind } from '../../src/index';
import type { ParamDescriptor } from '../../src/graph/param';
import {
  serializeGraph,
  type SerializedASLNode,
  type SerializedGraph,
} from '../../src/patcher/compiledPlugin';
import { KEYBOARD_KIND } from './analogKeyboard';
import { catalog, createMaterial, isToolEntry, type CatalogEntry } from './catalog';
import { formatJack } from './catalogSnapshot';
import { nodeInputs, nodeOutputs } from './controlInputs';
import { LINE_KIND, MASTER_KIND, MIDI_IN_KIND, MIDI_OUT_KIND } from './tools';

export const MATERIAL_CATALOG_VERSION = 1;

/**
 * The host I/O kinds a native palette places.
 *
 * `midiclip` is a tool in the web catalog and is deliberately not here:
 * `flattenPatch` does not know the kind, so a patch containing one fails to
 * export on both sides. Offering it in a palette whose whole job is producing
 * a runnable graph would only move that failure later.
 */
const TOOL_KINDS = new Set<string>([
  KEYBOARD_KIND,
  LINE_KIND,
  MASTER_KIND,
  MIDI_IN_KIND,
  MIDI_OUT_KIND,
  DEFAULT_PATCH_IO.transport,
]);

/**
 * Jacks for the plugin-backed palette entries. Stated here rather than read
 * off a constructed material, because constructing one needs its plugin
 * registered, which is a browser-side `registerAudioMaterial` call.
 *
 * `catalogSnapshot.ts` keeps the same table for its docs listing and is
 * missing `drum`, which it gets away with because a docs line without jacks
 * is cosmetic. A palette entry without jacks is a node nobody can wire, so
 * this table is separate and every Plugins entry must appear in it.
 */
const KERNEL_JACKS: Record<string, { inputs: readonly string[]; outputs: readonly string[] }> = {
  amp: { inputs: ['input'], outputs: ['audio'] },
  drum: { inputs: ['note', 'gate', 'velocity'], outputs: ['audio'] },
  grain: { inputs: ['note', 'gate', 'velocity'], outputs: ['audio'] },
  synth: { inputs: ['note', 'gate', 'velocity'], outputs: ['audio'] },
  ir: { inputs: ['input'], outputs: ['audio'] },
  spacereverb: { inputs: ['input'], outputs: ['audio'] },
};

export interface CatalogToolEntry {
  kind: string;
  label: string;
  category: string;
  /** One sentence for a palette row. Same copy the web editor prints. */
  blurb: string;
  inputs: readonly string[];
  outputs: readonly string[];
  /**
   * How each jack is written on a node, `formatJack`'s answer per entry in
   * `inputs` and `outputs`.
   *
   * The web editor says whether a jack is audio or CV with the socket's
   * shape: round for audio, square for control. A native editor drawing
   * through AudioKit Flow has no shape to spend, because Flow draws its own
   * ports, so the distinction has to be in the text. Generating the labels
   * here rather than restating the rule natively is what keeps `audio(cv)`
   * meaning the same thing in both: an outlet that is named audio and is
   * already a control signal.
   */
  inputLabels: readonly string[];
  outputLabels: readonly string[];
}

export interface CatalogKernelEntry extends CatalogToolEntry {
  /** Why a native host will not run it, in words a palette can print. */
  reason: string;
}

export interface CatalogMaterialEntry extends CatalogToolEntry {
  /**
   * Kinds whose non-audio outlets are derived from their audio rather than
   * being ordinary jacks. Flatten needs to know which is which: a cable off
   * an analysis node's `cents` becomes a `pitch` node reading that node's
   * audio, and a cable off a looper's `start` becomes the same looper with
   * its `field` swapped.
   *
   * Carried as data so the vocabulary is generated rather than restated in a
   * second language, where `isAnalysisKind` would be a list somebody has to
   * remember to extend.
   */
  trait?: 'analysis' | 'looper';
  cvPolarity: 'unipolar' | 'bipolar';
  polyphony: number;
  /**
   * Live audio inlets, which is what decides whether a cable mixes into a
   * port or maps onto a param. Derived from the graph's `port` nodes here so
   * the native side never re-derives it and disagrees.
   */
  audioInputs: readonly string[];
  automatable: readonly string[];
  /**
   * Declaration order of `params`.
   *
   * Load-bearing, not documentation. Flatten republishes a node's params in
   * declaration order and hands each one the next sequential address, and the
   * flattened graph's `inputs` list is that same order. A JSON object's key
   * order survives `JSON.parse` in JavaScript and does not survive decoding
   * into a Swift dictionary, so the order has to travel as an array or the
   * two sides assign different addresses to the same patch.
   */
  paramOrder: readonly string[];
  params: Readonly<Record<string, ParamDescriptor>>;
  graph: SerializedGraph;
}

export interface MaterialCatalogFixture {
  note: string;
  version: number;
  io: typeof DEFAULT_PATCH_IO;
  tools: CatalogToolEntry[];
  kernels: CatalogKernelEntry[];
  materials: CatalogMaterialEntry[];
}

/**
 * Jacks for a tool. `master`, `line` and the MIDI tools declare theirs on the
 * catalog entry; `transport` does not, because it is a real Material in the
 * web palette that flatten happens to treat as host I/O. Reading its jacks
 * off the material is what keeps the Transport node's six outlets from
 * arriving native as a node with nothing on it.
 */
function toolJacks(entry: CatalogEntry): { inputs: readonly string[]; outputs: readonly string[] } {
  if (entry.create) {
    const material = createMaterial(entry.kind);
    return { inputs: nodeInputs(material), outputs: nodeOutputs(material) };
  }
  return { inputs: entry.inputs ?? [], outputs: entry.outputs ?? [] };
}

function labelled(
  kind: string,
  inputs: readonly string[],
  outputs: readonly string[],
): Pick<CatalogToolEntry, 'inputs' | 'outputs' | 'inputLabels' | 'outputLabels'> {
  return {
    inputs,
    outputs,
    inputLabels: inputs.map((name) => formatJack(name, 'in', kind)),
    outputLabels: outputs.map((name) => formatJack(name, 'out', kind)),
  };
}

function toolEntry(entry: CatalogEntry): CatalogToolEntry {
  const jacks = toolJacks(entry);
  return {
    kind: entry.kind,
    label: entry.label,
    category: entry.category,
    blurb: entry.blurb ?? '',
    ...labelled(entry.kind, jacks.inputs, jacks.outputs),
  };
}

/**
 * Renumbers a serialized graph's node ids to 0-based first-visit order,
 * keeping the nested shape.
 *
 * Node ids come off a global counter, so the same material serializes with
 * different numbers depending on how many materials were constructed before
 * it in the process. That makes a generated file that changes without its
 * content changing, which is the one thing a checked-in artifact must not do.
 *
 * Ids stay meaningful after this: a shared subgraph is written more than once
 * with the same id each time, which is how a decoder re-shares it. They stop
 * being unique across *different* materials, which they never needed to be:
 * a native flatten mints fresh ids as it instantiates each node's graph, the
 * way `duplicate()` does in JavaScript. Splicing two graphs that both number
 * from zero without remapping would make one filter share state with another,
 * which is why that remap is not optional.
 */
function renumberGraph(graph: SerializedGraph): SerializedGraph {
  const assigned = new Map<number, number>();
  let next = 0;

  const visit = (node: SerializedASLNode): SerializedASLNode => {
    let id = assigned.get(node.id);
    if (id === undefined) {
      id = next++;
      assigned.set(node.id, id);
    }
    const inputs: Record<string, SerializedASLNode> = {};
    for (const key of Object.keys(node.inputs).sort()) {
      inputs[key] = visit(node.inputs[key]!);
    }
    const out: SerializedASLNode = { id, kind: node.kind, params: node.params, inputs };
    return node.list ? { ...out, list: node.list.map(visit) } : out;
  };

  const output = visit(graph.output);
  return {
    inputs: [...graph.inputs],
    output,
    ...(graph.channels ? { channels: graph.channels } : {}),
  };
}

function materialEntry(entry: CatalogEntry): CatalogMaterialEntry {
  const material = createMaterial(entry.kind);
  const trait = isAnalysisKind(entry.kind) ? 'analysis' : isLooperKind(entry.kind) ? 'looper' : undefined;
  return {
    kind: entry.kind,
    label: entry.label,
    category: entry.category,
    blurb: entry.blurb ?? '',
    ...(trait ? { trait } : {}),
    cvPolarity: material.cvPolarity,
    polyphony: material.polyphony,
    audioInputs: material.audioInputs,
    automatable: material.automatable,
    ...labelled(entry.kind, nodeInputs(material), nodeOutputs(material)),
    paramOrder: Object.keys(material.params),
    params: material.params,
    graph: renumberGraph(serializeGraph(material.graph)),
  };
}

export function buildMaterialCatalog(): MaterialCatalogFixture {
  const tools: CatalogToolEntry[] = [];
  const kernels: CatalogKernelEntry[] = [];
  const materials: CatalogMaterialEntry[] = [];
  const refused: string[] = [];

  for (const entry of catalog) {
    // Plugins exported this session are in the running editor's catalog and
    // are not part of the shipped palette.
    if (entry.kind.startsWith('user.')) continue;
    if (TOOL_KINDS.has(entry.kind)) {
      tools.push(toolEntry(entry));
      continue;
    }
    if (entry.category === 'Plugins') {
      const jacks = KERNEL_JACKS[entry.kind];
      if (!jacks) {
        throw new Error(
          `buildMaterialCatalog: plugin "${entry.kind}" has no jacks in KERNEL_JACKS. ` +
            'Add them, or a native palette draws a node with nothing to wire.',
        );
      }
      kernels.push({
        kind: entry.kind,
        label: entry.label,
        category: entry.category,
        blurb: entry.blurb ?? '',
        ...labelled(entry.kind, jacks.inputs, jacks.outputs),
        reason: 'names a kernel slot, which only a host with that kernel bound can run',
      });
      continue;
    }
    if (isToolEntry(entry) || !entry.create) continue;
    try {
      materials.push(materialEntry(entry));
    } catch (error) {
      refused.push(`${entry.kind}: ${(error as Error).message}`);
    }
  }

  if (materials.length === 0) {
    throw new Error('buildMaterialCatalog: no materials resolved, which cannot be right');
  }
  if (refused.length > 0) {
    // A palette entry that will not construct is a broken palette, not a
    // catalog to ship. Plugin-backed entries are handled above and never
    // reach here.
    throw new Error(`buildMaterialCatalog: could not construct:\n  ${refused.join('\n  ')}`);
  }

  return {
    note:
      'Generated by editor/scripts/emit-material-catalog.ts. ' +
      'Do not edit by hand: run `npm run fixtures:materials`.',
    version: MATERIAL_CATALOG_VERSION,
    io: DEFAULT_PATCH_IO,
    tools,
    kernels,
    materials,
  };
}
