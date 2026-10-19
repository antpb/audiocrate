/**
 * Turning a patch document (the free-form AudioMaterial graph a node editor
 * saves) into ONE AudioMaterial a DAW can host on `track.materials` or
 * `track.instrument`.
 *
 * A patch is modular-synth topology: N Materials sharing one signal path,
 * eight oscillator voices summed into one filter. A hosted plugin is the
 * other shape: one AudioMaterial, one `VoicePool`, N copies of the whole chain,
 * one per voice. Flattening converts the first into the second by splicing
 * every node's ASL graph into a single graph:
 *
 *  - An audio cable into an inlet replaces that inlet's `port` node with
 *    the upstream node's output (stacked cables mix).
 *  - A CV cable into a param replaces that `param` node with the upstream
 *    signal mapped onto the param's declared [min, max] via `range`.
 *    Unipolar sources (ADSR) are lifted 0..1 to -1..1 first so 0 is min
 *    and 1 is max. Bipolar sources (LFO) already sit on -1..1.
 *  - Every remaining declared param is republished as `{nodeId}_{name}`,
 *    so two gains in one patch do not collide.
 *  - Keyboard, Line, Master and Transport nodes are host I/O, not DSP.
 *    Master is the output tap, Line is the hosted insert's own input, and
 *    a Keyboard cable into a note jack only marks the patch as an
 *    instrument: the inner graph's `note` / `velocity` params already
 *    read the voice. MIDI In is the same note source from a hardware port.
 *    A cable from another module into `note`, `velocity`, `gate` or `trig`
 *    is different: those are graph-driven voice jacks (a sequencer into
 *    an oscillator). They replace the inner param with the upstream
 *    signal in real units: MIDI 48..72 for `note`, 0..1 for the others.
 *    MIDI Out is a sink, like Master, and does not enter the audio graph.
 *    Transport params are the patcher's session tempo; a hosted DAW already
 *    hosted DAW already publishes that snapshot, so flatten keeps the
 *    outlets as `transport.*` reads and drops the node's own knobs.
 *
 * This is deliberately ASL-only. A graph that names a kernel slot (amp,
 * grain, anything block-shaped) cannot flatten, because the flattened
 * AudioMaterial would need that kernel bound per voice, which is the portable
 * kernel path, not this one.
 */
import { paramNode, peak, pitch, rms } from '../asl/builders';
import { transport } from '../asl/transportNodes';
import { constNode, makeNode, type ASLNode } from '../asl/types';
import { ASLValue } from '../asl/ASLValue';
import { AudioMaterial, type VoiceStealingPolicy } from '../graph/AudioMaterial';
import { isAnalysisKind } from '../materials/meters';
import { isLooperKind, isLooperPulseOutput } from '../materials/time';
import type { ParamDescriptor } from '../graph/param';
import { planVoicing, type Voicing, type VoicingRole } from './voicing';

export interface PatchDocumentNode {
  id: string;
  kind: string;
  params?: Record<string, number>;
  /**
   * In an instrument, whether this module runs per voice or once on the sum
   * of the voices (`voicing.ts`). Omitted means summed wherever the patch
   * allows it. Ignored where it cannot apply.
   */
  voicing?: Voicing;
}

export interface PatchDocumentConnection {
  source: string;
  sourceOutput: string;
  target: string;
  targetInput: string;
}

/** The structural shape flatten needs. A patcher's own saved document is a superset. */
export interface PatchDocument {
  nodes: readonly PatchDocumentNode[];
  connections: readonly PatchDocumentConnection[];
}

/**
 * The node kinds a patch document uses for host I/O. Crate does not ship a
 * node editor, so these are conventions of the document, not plugins; a
 * host whose editor names them differently passes its own.
 */
export interface PatchIoKinds {
  master: string;
  line: string;
  keyboard: string;
  transport: string;
  midiIn: string;
  midiOut: string;
}

export const DEFAULT_PATCH_IO: PatchIoKinds = {
  master: 'master',
  line: 'line',
  keyboard: 'keyboard',
  transport: 'transport',
  midiIn: 'midiin',
  midiOut: 'midiout',
};

/** Inlets a keyboard drives per note rather than per sample. */
export const NOTE_INPUTS: ReadonlySet<string> = new Set(['note', 'gate', 'velocity', 'trig', 'clock', 'reset']);

export interface FlattenPatchOptions {
  /**
   * `kind -> AudioMaterial` for every non-I/O node in the document. Crate has no
   * "list every AudioMaterial" API on purpose; the caller (a patcher's catalog, a
   * host's registry) says what a kind means. Returning null throws.
   */
  resolve: (kind: string) => AudioMaterial | null | undefined;
  name?: string;
  kind?: string;
  /** Omit to detect: any keyboard cable into a note jack means instrument. */
  role?: 'insert' | 'instrument';
  /** Instrument voice count. Defaults to the largest inner polyphony. */
  polyphony?: number;
  voiceStealing?: VoiceStealingPolicy;
  io?: Partial<PatchIoKinds>;
}

export function detectPatchRole(patch: PatchDocument, io: Partial<PatchIoKinds> = {}): 'insert' | 'instrument' {
  const keyboardKind = io.keyboard ?? DEFAULT_PATCH_IO.keyboard;
  const midiInKind = io.midiIn ?? DEFAULT_PATCH_IO.midiIn;
  const midiOutKind = io.midiOut ?? DEFAULT_PATCH_IO.midiOut;
  const kinds = new Map(patch.nodes.map((node) => [node.id, node.kind]));
  for (const conn of patch.connections) {
    const source = kinds.get(conn.source);
    const target = kinds.get(conn.target);
    if (target === midiOutKind) continue;
    if ((source === keyboardKind || source === midiInKind) && NOTE_INPUTS.has(conn.targetInput)) {
      return 'instrument';
    }
  }
  return 'insert';
}

export function flattenPatch(patch: PatchDocument, options: FlattenPatchOptions): AudioMaterial {
  const io: PatchIoKinds = { ...DEFAULT_PATCH_IO, ...options.io };
  const role = options.role ?? detectPatchRole(patch, io);
  const name = options.name ?? 'Patch';

  const kinds = new Map(patch.nodes.map((node) => [node.id, node.kind]));
  const isIo = (kind: string | undefined): boolean =>
    kind === io.master ||
    kind === io.line ||
    kind === io.keyboard ||
    kind === io.transport ||
    kind === io.midiIn ||
    kind === io.midiOut;

  const materials = new Map<string, AudioMaterial>();
  for (const node of patch.nodes) {
    if (isIo(node.kind)) continue;
    const proto = options.resolve(node.kind);
    if (!proto) throw new Error(`flattenPatch: nothing resolves kind "${node.kind}" (node "${node.id}")`);
    const material = proto.duplicate();
    for (const [param, value] of Object.entries(node.params ?? {})) {
      if (!(param in material.params)) continue;
      try {
        material.setParam(param, value);
      } catch {
        /* an out-of-range value in the document keeps the default */
      }
    }
    rejectKernels(material);
    materials.set(node.id, material);
  }
  if (materials.size === 0) throw new Error('flattenPatch: the patch has no Materials to flatten');
  if (![...kinds.values()].includes(io.master)) {
    throw new Error(`flattenPatch: the patch has no "${io.master}" node, so it has no output`);
  }

  const order = topoSort(patch, materials, kinds, io);

  // Which modules run per voice and which once on the voices' sum. An
  // insert has no voices, and an instrument with nothing to sum flattens
  // exactly as it always did: one graph, copied per voice.
  const voicing = role === 'instrument'
    ? planVoicing({
        nodes: patch.nodes,
        connections: patch.connections,
        materials,
        voiceSourceKinds: new Set([io.keyboard, io.midiIn]),
        noteInputs: NOTE_INPUTS,
      })
    : null;
  const roleOf = (id: string): VoicingRole => voicing?.role.get(id) ?? 'instanced';
  const split = voicing !== null && summedReachesMaster(patch, kinds, io, (id) => roleOf(id) === 'summed');

  // `voice` is every module when nothing is split. Split, it is the
  // instanced and global modules, and `bus` the summed and global ones.
  const voiceFlat = new Map<string, ASLNode>();
  const busFlat = new Map<string, ASLNode>();
  /** Per-voice signals handed to the bus, in first-use order. */
  const sends: ASLNode[] = [];
  const sendPorts: ASLNode[] = [];
  const sendPort = (node: ASLNode): ASLNode => {
    let k = sends.indexOf(node);
    if (k === -1) {
      k = sends.length;
      sends.push(node);
      sendPorts.push(makeNode('port', {}, { name: `send${k}` }));
    }
    return sendPorts[k]!;
  };

  /**
   * A cable's upstream value on the side being built. On the bus, a
   * per-voice source is not available as a node: it arrives as the sum of
   * every voice's copy, through that signal's send port.
   */
  const upstream = (side: 'voice' | 'bus', source: string, field?: (audio: ASLNode) => ASLNode | null): ASLNode | null => {
    if (side === 'bus' && roleOf(source) === 'instanced') {
      const audio = voiceFlat.get(source);
      if (!audio) return null;
      const node = field ? field(audio) : audio;
      return node ? sendPort(node) : null;
    }
    const audio = (side === 'voice' ? voiceFlat : busFlat).get(source);
    if (!audio) return null;
    return field ? field(audio) : audio;
  };

  const build = (id: string, side: 'voice' | 'bus'): ASLNode => {
    const material = materials.get(id)!;
    const audioSources = new Map<string, ASLNode[]>();
    const cvSources = new Map<string, ASLNode[]>();
    const cvAbsolute = new Map<string, ASLNode>();
    for (const conn of patch.connections) {
      if (conn.target !== id) continue;
      const sourceKind = kinds.get(conn.source);
      if (sourceKind === io.keyboard || sourceKind === io.midiIn) continue;
      const inlet = conn.targetInput;
      if (sourceKind === io.transport) {
        const field = transportOutletNode(conn.sourceOutput);
        if (!field) continue;
        if (material.audioInputs.includes(inlet)) {
          push(audioSources, inlet, field);
        } else if (inlet in material.params) {
          cvAbsolute.set(inlet, field);
        }
        continue;
      }
      if (sourceKind && isAnalysisKind(sourceKind) && conn.sourceOutput !== 'audio') {
        const field = upstream(side, conn.source, (audio) => analysisOutletNode(conn.sourceOutput, audio));
        if (!field) continue;
        if (material.audioInputs.includes(inlet)) {
          push(audioSources, inlet, field);
        } else if (inlet in material.params) {
          cvAbsolute.set(inlet, field);
        }
        continue;
      }
      if (sourceKind && isLooperKind(sourceKind) && isLooperPulseOutput(conn.sourceOutput)) {
        const field = upstream(side, conn.source, (audio) => looperOutletNode(conn.sourceOutput, audio));
        if (!field) continue;
        if (material.audioInputs.includes(inlet)) {
          push(audioSources, inlet, field);
        } else if (inlet in material.params) {
          push(cvSources, inlet, asBipolar(field, 'unipolar'));
        }
        continue;
      }
      if (material.audioInputs.includes(inlet)) {
        const node = sourceKind === io.line ? insertInputNode() : upstream(side, conn.source);
        if (node) push(audioSources, inlet, node);
        continue;
      }
      if (NOTE_INPUTS.has(inlet) && sourceKind !== io.line) {
        const node = upstream(side, conn.source);
        if (node) {
          const polarity = materials.get(conn.source)?.cvPolarity ?? 'bipolar';
          cvAbsolute.set(inlet, voiceJackNode(asBipolar(node, polarity), inlet));
        }
        continue;
      }
      if (inlet in material.params && sourceKind !== io.line) {
        const node = upstream(side, conn.source);
        if (node) {
          const polarity = materials.get(conn.source)?.cvPolarity ?? 'bipolar';
          push(cvSources, inlet, asBipolar(node, polarity));
        }
      }
    }
    const cv = new Map<string, ASLNode>();
    for (const [param, node] of cvAbsolute) {
      cv.set(param, node);
    }
    for (const [param, sources] of cvSources) {
      if (cv.has(param)) continue;
      const descriptor = material.params[param]!;
      cv.set(param, makeNode('range', { source: mixNodes(sources) }, { min: descriptor.min, max: descriptor.max }));
    }
    return rewrite(material.graph.output, {
      audio: audioSources,
      cv,
      declared: material.params,
      prefix: id,
      memo: new Map(),
      renamed: new Map(),
    });
  };

  for (const id of order) {
    const r = roleOf(id);
    if (!split || r !== 'summed') voiceFlat.set(id, build(id, 'voice'));
    if (split && r !== 'instanced') busFlat.set(id, build(id, 'bus'));
  }

  const outputSide: 'voice' | 'bus' = split ? 'bus' : 'voice';
  const outputs: ASLNode[] = [];
  for (const conn of patch.connections) {
    if (kinds.get(conn.target) !== io.master) continue;
    const sourceKind = kinds.get(conn.source);
    const node =
      sourceKind === io.line
        ? insertInputNode()
        : sourceKind === io.transport
          ? transportOutletNode(conn.sourceOutput)
          : sourceKind && isLooperKind(sourceKind) && isLooperPulseOutput(conn.sourceOutput)
            ? upstream(outputSide, conn.source, (audio) => looperOutletNode(conn.sourceOutput, audio))
            : upstream(outputSide, conn.source);
    if (node) outputs.push(node);
  }
  if (outputs.length === 0) {
    throw new Error(`flattenPatch: nothing is patched into the "${io.master}" node; the plugin would be silent`);
  }
  const output = mixNodes(outputs);

  const published: Record<string, ParamDescriptor> = {};
  let address = 0;
  for (const id of order) {
    const material = materials.get(id)!;
    for (const [param, descriptor] of Object.entries(material.params)) {
      if (cvReplaced(patch, kinds, materials, io, id, param)) continue;
      // Fresh sequential addresses: the inner Materials' own addresses would
      // collide across nodes, and a hosted param UI addresses by number.
      published[`${id}_${param}`] = {
        ...descriptor,
        default: material.getParam(param),
        address: address++,
      } as ParamDescriptor;
    }
  }

  const polyphony = role === 'instrument'
    ? options.polyphony ?? Math.max(1, ...[...materials.values()].map((m) => m.polyphony))
    : 1;

  // No send means nothing per voice reaches the bus: nothing to sum.
  if (!split || sends.length === 0) {
    return new AudioMaterial({
      name,
      kind: options.kind ?? name,
      params: published,
      automatable: Object.keys(published),
      polyphony,
      voiceStealing: options.voiceStealing,
      graph: () => new ASLValue(output),
    });
  }

  // Split: the voices render their sends, and `output` (built on the bus
  // side) is what runs once on their sum.
  const bus = new AudioMaterial({
    name: `${name} (summed)`,
    kind: options.kind ?? name,
    params: published,
    automatable: Object.keys(published),
    graph: () => new ASLValue(output),
  });
  const voiceOutput = mixNodes(sends);
  return new AudioMaterial({
    name,
    kind: options.kind ?? name,
    params: published,
    automatable: Object.keys(published),
    polyphony,
    voiceStealing: options.voiceStealing,
    graph: () => new ASLValue(voiceOutput),
    sends,
    bus,
  });
}

/**
 * Whether any summed module is actually heard. A summed module that reaches
 * Master only through nothing (a dead end) does not justify a bus, and
 * splitting for it would change a patch's graph for no sound at all.
 */
function summedReachesMaster(
  patch: PatchDocument,
  kinds: Map<string, string>,
  io: PatchIoKinds,
  summed: (id: string) => boolean,
): boolean {
  const feeds = new Map<string, string[]>();
  for (const conn of patch.connections) {
    const list = feeds.get(conn.source);
    if (list) list.push(conn.target);
    else feeds.set(conn.source, [conn.target]);
  }
  const reaches = new Map<string, boolean>();
  const visit = (id: string, path: Set<string>): boolean => {
    const known = reaches.get(id);
    if (known !== undefined) return known;
    if (path.has(id)) return false;
    path.add(id);
    let result = false;
    for (const next of feeds.get(id) ?? []) {
      if (kinds.get(next) === io.master || visit(next, path)) {
        result = true;
        break;
      }
    }
    path.delete(id);
    reaches.set(id, result);
    return result;
  };
  return patch.nodes.some((node) => summed(node.id) && visit(node.id, new Set()));
}

function push(map: Map<string, ASLNode[]>, key: string, node: ASLNode): void {
  const list = map.get(key);
  if (list) list.push(node);
  else map.set(key, [node]);
}

/** The hosted insert's own main input, whatever inlet the cable landed on. */
function insertInputNode(): ASLNode {
  return makeNode('port', {}, { name: 'input' });
}

/** A Transport tool outlet is the matching `transport.*` field, in real units. */
function transportOutletNode(output: string): ASLNode | null {
  switch (output) {
    case 'bpm':
      return transport.bpm().node;
    case 'beats':
      return transport.beats().node;
    case 'bars':
      return transport.bars().node;
    case 'playing':
      return transport.playing().node;
    case 'beatsPerBar':
      return transport.beatsPerBar().node;
    case 'beatUnit':
      return transport.beatUnit().node;
    case 'phase':
      return transport.phase().node;
    case 'pulse':
    case 'cv':
    case 'audio':
      return transport.pulse().node;
    default:
      return null;
  }
}

function findLooperNode(node: ASLNode | undefined, seen = new Set<number>()): ASLNode | null {
  if (!node || seen.has(node.id)) return null;
  seen.add(node.id);
  if (node.kind === 'looper' && String(node.params.field ?? 'audio') === 'audio') return node;
  for (const child of Object.values(node.inputs)) {
    const found = findLooperNode(child, seen);
    if (found) return found;
  }
  for (const child of node.list ?? []) {
    const found = findLooperNode(child, seen);
    if (found) return found;
  }
  return null;
}

function looperOutletNode(output: string, audio: ASLNode | undefined): ASLNode | null {
  if (!audio || (output !== 'start' && output !== 'end')) return null;
  const proto = findLooperNode(audio);
  if (!proto) return null;
  return makeNode('looper', proto.inputs, { ...proto.params, field: output });
}

function analysisOutletNode(output: string, audio: ASLNode): ASLNode | null {
  const signal = new ASLValue(audio);
  switch (output) {
    case 'peak':
      return peak(signal).node;
    case 'rms':
      return rms(signal).node;
    case 'note':
    case 'midi':
      return pitch(signal, { field: 'midi' }).node;
    case 'cv':
      return makeNode(
        'mul',
        {
          a: makeNode('add', { a: pitch(signal, { field: 'midi' }).node, b: constNode(-69) }, {}),
          b: constNode(1 / 12),
        },
        {},
      );
    case 'hz':
      return pitch(signal, { field: 'hz' }).node;
    case 'cents':
      return pitch(signal, { field: 'cents' }).node;
    case 'gate':
      return pitch(signal, { field: 'gate' }).node;
    default:
      return null;
  }
}

function mixNodes(nodes: ASLNode[]): ASLNode {
  return nodes.length === 1 ? nodes[0]! : makeNode('mix', {}, {}, nodes);
}

/** `range` is -1..1. Unipolar 0..1 becomes that before the map. */
/** A graph-driven voice jack is in real units, not a param range map. */
function voiceJackNode(source: ASLNode, inlet: string): ASLNode {
  const midi = inlet === 'note';
  return makeNode('range', { source }, { min: midi ? 48 : 0, max: midi ? 72 : 1 });
}

function asBipolar(node: ASLNode, polarity: 'unipolar' | 'bipolar'): ASLNode {
  if (polarity === 'bipolar') return node;
  return makeNode(
    'add',
    {
      a: makeNode('mul', { a: node, b: constNode(2) }, {}),
      b: constNode(-1),
    },
    {},
  );
}

function cvReplaced(
  patch: PatchDocument,
  kinds: Map<string, string>,
  materials: Map<string, AudioMaterial>,
  io: PatchIoKinds,
  id: string,
  param: string,
): boolean {
  const material = materials.get(id)!;
  if (material.audioInputs.includes(param)) return false;
  return patch.connections.some((conn) => {
    if (conn.target !== id || conn.targetInput !== param) return false;
    if (kinds.get(conn.source) === io.keyboard || kinds.get(conn.source) === io.midiIn) return false;
    return materials.has(conn.source) || kinds.get(conn.source) === io.transport;
  });
}

/**
 * AudioMaterial-to-material edges only (audio and CV both order evaluation).
 * Cables to and from the I/O nodes do not constrain order.
 */
function topoSort(
  patch: PatchDocument,
  materials: Map<string, AudioMaterial>,
  kinds: Map<string, string>,
  io: PatchIoKinds,
): string[] {
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const id of materials.keys()) {
    incoming.set(id, new Set());
    outgoing.set(id, new Set());
  }
  for (const conn of patch.connections) {
    if (!materials.has(conn.source) || !materials.has(conn.target)) continue;
    if (kinds.get(conn.source) === io.keyboard || kinds.get(conn.source) === io.midiIn) continue;
    const target = materials.get(conn.target)!;
    const relevant =
      target.audioInputs.includes(conn.targetInput) ||
      conn.targetInput in target.params ||
      NOTE_INPUTS.has(conn.targetInput);
    if (!relevant) continue;
    incoming.get(conn.target)!.add(conn.source);
    outgoing.get(conn.source)!.add(conn.target);
  }
  const order: string[] = [];
  const ready = [...materials.keys()].filter((id) => incoming.get(id)!.size === 0);
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of outgoing.get(id)!) {
      const deps = incoming.get(next)!;
      deps.delete(id);
      if (deps.size === 0) ready.push(next);
    }
  }
  if (order.length !== materials.size) {
    throw new Error('flattenPatch: the patch has a feedback cycle, which a single flattened graph cannot express');
  }
  return order;
}

function rejectKernels(material: AudioMaterial): void {
  const seen = new Set<number>();
  const walk = (node: ASLNode): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    if (node.kind === 'kernel') {
      throw new Error(
        `flattenPatch: "${material.name}" names a kernel slot. Only pure ASL Materials flatten; ` +
          'kernel DSP ships as its own plugin package or portable kernel.',
      );
    }
    for (const child of Object.values(node.inputs)) walk(child);
    for (const child of node.list ?? []) walk(child);
  };
  walk(material.graph.output);
}

interface RewriteContext {
  audio: Map<string, ASLNode[]>;
  cv: Map<string, ASLNode>;
  declared: Readonly<Record<string, ParamDescriptor>>;
  prefix: string;
  memo: Map<number, ASLNode>;
  renamed: Map<string, ASLNode>;
}

/**
 * Rebuilds an AudioMaterial's built graph with substitutions, preserving shared
 * subtrees (the interpreter keys per-node state by id, so an untouched node
 * keeps its identity and a touched path gets fresh ids from `makeNode`).
 *
 * Param nodes that are NOT declared params (`note`, `velocity`, live voice
 * inputs) pass through untouched: they resolve by name against the
 * flattened voice, which is exactly what makes the instrument case work.
 */
function rewrite(node: ASLNode, ctx: RewriteContext): ASLNode {
  const cached = ctx.memo.get(node.id);
  if (cached) return cached;
  let result: ASLNode;
  if (node.kind === 'param') {
    const paramName = String(node.params.name ?? '');
    const cv = ctx.cv.get(paramName);
    if (cv) {
      result = cv;
    } else if (paramName in ctx.declared) {
      let renamed = ctx.renamed.get(paramName);
      if (!renamed) {
        renamed = paramNode(`${ctx.prefix}_${paramName}`).node;
        ctx.renamed.set(paramName, renamed);
      }
      result = renamed;
    } else {
      result = node;
    }
  } else if (node.kind === 'port') {
    const portName = String(node.params.name ?? '');
    const sources = ctx.audio.get(portName);
    result = sources && sources.length > 0 ? mixNodes(sources) : node;
  } else {
    let changed = false;
    const inputs: Record<string, ASLNode> = {};
    for (const [key, child] of Object.entries(node.inputs)) {
      const next = rewrite(child, ctx);
      inputs[key] = next;
      if (next !== child) changed = true;
    }
    let list: ASLNode[] | undefined;
    if (node.list) {
      list = node.list.map((child) => rewrite(child, ctx));
      if (list.some((next, i) => next !== node.list![i])) changed = true;
    }
    result = changed ? makeNode(node.kind, inputs, { ...node.params }, list ?? node.list) : node;
  }
  ctx.memo.set(node.id, result);
  return result;
}
