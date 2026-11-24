/**
 * homecrate's crate AU, read on the web.
 *
 * On device a crate patch is not its own Audio Unit. Every patch rides inside
 * one generic AU (`crat`, by `NAMp`): an instrument as `aumu`, an effect as
 * `aufx`. The slot's saved state carries the whole patch:
 *
 *   cratePatch          the editable `crate.patch` document
 *   crateCompiledGraph  the flattened graph and param schema
 *                       (`CompiledMaterialDocument`), which CrateASL runs
 *   param_N             saved values, by parameter address
 *   cratePluginLabel    what the user named it
 *
 * So the material cannot exist before its preset is read, which is what
 * `AudioMaterialPlugin.createFromPreset` is for. It is built from the
 * compiled graph, the same artifact the device runs, so the web plays the
 * graph the artist heard rather than a second lowering of the patch.
 * A crate patch never contains a kernel (`flattenPatch` rejects them), so
 * this needs nothing from a worklet beyond the ASL interpreter.
 */
import { ASLValue } from '../asl/ASLValue';
import { constNode, makeNode, type ASLNode, type NodeKind } from '../asl/types';
import { AudioMaterial } from '../graph/AudioMaterial';
import type { ParamDescriptor } from '../graph/param';
import { AU_TYPE_EFFECT, AU_TYPE_INSTRUMENT, AU_TYPE_MUSIC_EFFECT, decodeAddressedParams } from '../host/pluginSlots';
import { decodePresetBlob } from '../loaders/decodeKeyedArchive';
import type { AudioMaterialPlugin } from '../registry/AudioMaterialPlugin';
import {
  inflateSerializedGraph,
  type CompiledMaterialDocument,
  type SerializedASLNode,
  type SerializedGraph,
  type SharedSerializedGraph,
} from './compiledPlugin';

/** `crat`, the crate AU's component subtype. */
export const HOMECRATE_CRATE_SUBTYPE = 0x63726174;
/** `NAMp`, the manufacturer homecrate's crate AU registers under. */
export const HOMECRATE_CRATE_MANUFACTURER = 0x4e414d70;

/**
 * Asset keys a crate material carries: the compiled document it was built
 * from, and the slot's seed. For a host that runs the patch some other way
 * than this material's graph, such as the CrateC kernel in homecrate's
 * worklet, which builds its own plan from the same document.
 */
export const CRATE_COMPILED_ASSET = 'crate.compiled';
export const CRATE_SEED_ASSET = 'crate.seed';

export interface NativeCratePreset {
  /** The compiled graph, or null when the slot has none (an empty crate). */
  compiled: CompiledMaterialDocument | null;
  /** Saved values by param name, read from `param_N` against the schema. */
  values: Record<string, number>;
  label: string | null;
  /** `crateSeed`, for a patch with noise. Carried, not yet applied per voice. */
  seed: number | null;
}

function emptyNativeCratePreset(): NativeCratePreset {
  return { compiled: null, values: {}, label: null, seed: null };
}

function asCompiledDocument(text: unknown): CompiledMaterialDocument | null {
  if (typeof text !== 'string' || !text) return null;
  const doc = JSON.parse(text) as Partial<CompiledMaterialDocument> | null;
  if (!doc || typeof doc !== 'object' || !doc.graph || !doc.params || typeof doc.params !== 'object') return null;
  return {
    ...(doc as CompiledMaterialDocument),
    graph: inflateSerializedGraph(doc.graph as SerializedGraph | SharedSerializedGraph),
  };
}

/** Reads a crate AU's saved state. Throws on a blob that is not a preset at all. */
export function decodeNativeCratePreset(blob: string): NativeCratePreset {
  const raw = decodePresetBlob(blob);
  const compiled = asCompiledDocument(raw.crateCompiledGraph);
  return {
    compiled,
    values: compiled ? decodeAddressedParams(raw, compiled.params) : {},
    label: typeof raw.cratePluginLabel === 'string' && raw.cratePluginLabel ? raw.cratePluginLabel : null,
    seed: typeof raw.crateSeed === 'number' ? raw.crateSeed : null,
  };
}

/**
 * Turns serialized nodes back into ASL nodes. Every node is made fresh
 * (`makeNode`), so its id cannot collide with one from another graph in the
 * same scene, and a node written under one id is built once: the input
 * `inflateSerializedGraph` shared stays shared, which `compileVoice` relies
 * on (one filter, one delay line).
 */
function nodeBuilder(): (node: SerializedASLNode) => ASLNode {
  const built = new Map<number, ASLNode>();
  const build = (node: SerializedASLNode): ASLNode => {
    const done = built.get(node.id);
    if (done) return done;
    const inputs: Record<string, ASLNode> = {};
    for (const [key, child] of Object.entries(node.inputs)) inputs[key] = build(child);
    const list = node.list ? node.list.map(build) : undefined;
    const out = makeNode(node.kind as NodeKind, inputs, { ...node.params }, list);
    built.set(node.id, out);
    return out;
  };
  return build;
}

function materialFromGraph(
  graph: SerializedGraph,
  params: Record<string, ParamDescriptor>,
  options: { name: string; kind: string; polyphony?: number },
): AudioMaterial {
  const build = nodeBuilder();
  const output = build(graph.output);
  const sends = graph.sends?.map(build);
  const bus = graph.bus ? materialFromGraph(graph.bus, params, { name: `${options.name} bus`, kind: options.kind }) : undefined;
  return new AudioMaterial({
    name: options.name,
    kind: options.kind,
    params,
    polyphony: options.polyphony,
    channels: graph.channels,
    ...(sends && sends.length ? { sends } : {}),
    ...(bus ? { bus } : {}),
    graph: () => new ASLValue(output),
  });
}

/**
 * An AudioMaterial from a compiled document (`crate.plugin`'s `compiled`, or a
 * crate AU's `crateCompiledGraph`). For a host with no patcher: this is the
 * JavaScript twin of what CrateASL does with the same JSON.
 */
export function materialFromCompiled(
  doc: CompiledMaterialDocument,
  options: { kind: string; name?: string },
): AudioMaterial {
  const graph = inflateSerializedGraph(doc.graph);
  return materialFromGraph(graph, { ...doc.params }, {
    name: options.name ?? doc.name,
    kind: options.kind,
    polyphony: doc.role === 'instrument' ? doc.polyphony : undefined,
  });
}

function nativeCratePlugin(kind: string, role: 'insert' | 'instrument'): AudioMaterialPlugin<NativeCratePreset> {
  const empty = (): AudioMaterial =>
    new AudioMaterial({
      name: role === 'instrument' ? 'Crate' : 'Crate FX',
      kind,
      // An empty crate: silence as an instrument, a straight wire as an effect.
      graph: (ctx) => (role === 'instrument' ? new ASLValue(constNode(0)) : ctx.input!),
    });
  return {
    kind,
    role,
    label: role === 'instrument' ? 'Crate (instrument)' : 'Crate (effect)',
    host: {
      componentSubType: HOMECRATE_CRATE_SUBTYPE,
      componentManufacturer: HOMECRATE_CRATE_MANUFACTURER,
      componentTypes: role === 'instrument' ? [AU_TYPE_INSTRUMENT] : [AU_TYPE_EFFECT, AU_TYPE_MUSIC_EFFECT],
    },
    create: empty,
    decodePreset: decodeNativeCratePreset,
    emptyPreset: emptyNativeCratePreset,
    createFromPreset(preset) {
      if (!preset.compiled) return empty();
      const material = materialFromCompiled(preset.compiled, { kind, name: preset.label ?? undefined });
      material.setAsset(CRATE_COMPILED_ASSET, preset.compiled);
      if (preset.seed !== null) material.setAsset(CRATE_SEED_ASSET, preset.seed);
      for (const [name, value] of Object.entries(preset.values)) {
        try {
          material.setParam(name, value);
        } catch {
          /* an out-of-range saved value keeps the default */
        }
      }
      return material;
    },
  };
}

/** The crate AU as an instrument (`aumu`): a patch played from MIDI. */
export const nativeCrateInstrumentPlugin = nativeCratePlugin('homecrate.crate', 'instrument');
/** The crate AU as an effect (`aufx` / `aumf`): a patch on a track's inserts. */
export const nativeCrateEffectPlugin = nativeCratePlugin('homecrate.crate-fx', 'insert');
