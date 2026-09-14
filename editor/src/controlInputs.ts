import {
  LOOPER_OUTPUTS,
  TRANSPORT_OUTPUTS,
  analysisOutputs,
  isAnalysisKind,
  isLooperKind,
  isTransportKind,
  type AudioMaterial,
} from '../../src/index';
import { isControlJack } from './analogKeyboard';

interface WalkNode {
  id: number;
  kind: string;
  params: Readonly<Record<string, unknown>>;
  inputs: Readonly<Record<string, WalkNode>>;
  list?: readonly WalkNode[];
}

// `reset` sits here with the other triggers rather than with the knobs. It
// is a jack: what arrives is an edge, and mapping an edge across a
// parameter's range is not a thing anyone wants.
const CONTROL_PARAMS = new Set(['note', 'gate', 'velocity', 'clock', 'trig', 'reset']);
const CV_OUTPUT_KINDS = new Set(['lfo', 'sequencer']);
const MAX_CV_JACKS = 10;

/** Kernels whose graph is opaque, so their jacks cannot be read off it. */
const OPAQUE_KERNELS = new Set(['synth', 'grain', 'drum']);

/** Voice and clock jacks the graph reads, plus automatable params as CV. */
export function controlInputs(material: AudioMaterial): string[] {
  const names = new Set<string>();
  walk(material.graph.output as WalkNode, names, new Set());
  if (OPAQUE_KERNELS.has(material.kind)) {
    names.add('note');
    names.add('gate');
    names.add('velocity');
  } else if (material.polyphony > 1) {
    // `gate` only. It used to add note and velocity too, which is how the
    // ADSR came to advertise a `note` jack: it is polyphonic and has no pitch,
    // so the jack accepted cables and there was nothing behind it. Where a
    // voice really does read note or velocity, the walk above finds them.
    //
    // `gate` is the exception that stays, because it is not read from the
    // graph by anything: it is the voice allocator's, and a keyboard cable
    // into it is a statement about what plays this module rather than a
    // signal. `flattenPatch` treats it that way too, contributing no node.
    names.add('gate');
  }
  return ['note', 'gate', 'velocity', 'clock', 'trig', 'reset'].filter((name) => names.has(name));
}

/**
 * Automatable params as CV jacks.
 *
 * Deliberately not filtered by what the graph reads, though that was tried.
 * Spatial positions and the Transport's tempo are read by the host rather than
 * by the graph, so filtering removed jacks that are not dead, they are
 * *host-driven*: an automation lane writes them, they are saved with the
 * patch, and the spatial renderer and the session clock act on them. What a
 * cable into one cannot do is drive it, and that is a real gap, but it is a
 * gap in those two modules rather than in this derivation. `DeadJackTests`
 * carries the five of them with that reason attached.
 */
export function cvInputs(material: AudioMaterial): string[] {
  const taken = new Set([...material.audioInputs, ...controlInputs(material)]);
  return material.automatable.filter((name) => !taken.has(name)).slice(0, MAX_CV_JACKS);
}

export function nodeInputs(material: AudioMaterial): string[] {
  const audio = [...material.audioInputs];
  const extra = [...controlInputs(material), ...cvInputs(material)].filter((name) => !audio.includes(name));
  return [...audio, ...extra];
}

/** Modulators show a cv jack so cutoff cables are not mistaken for audio mix. */
export function nodeOutputs(material: AudioMaterial): string[] {
  if (isTransportKind(material.kind)) return [...TRANSPORT_OUTPUTS];
  if (isAnalysisKind(material.kind)) return [...analysisOutputs(material.kind)];
  if (isLooperKind(material.kind)) return [...LOOPER_OUTPUTS];
  return material.cvPolarity === 'unipolar' || CV_OUTPUT_KINDS.has(material.kind) ? ['cv'] : ['audio'];
}

/** Analyser keys for a live node. Always include `audio` so scopes and old cables still resolve. */
export function tapOutputNames(material: AudioMaterial | undefined): string[] {
  if (material && isTransportKind(material.kind)) return [...TRANSPORT_OUTPUTS];
  if (material && isAnalysisKind(material.kind)) return [...analysisOutputs(material.kind)];
  if (material && isLooperKind(material.kind)) return [...LOOPER_OUTPUTS];
  const names = new Set(material ? nodeOutputs(material) : ['audio']);
  names.add('audio');
  return [...names];
}

export function isAudioInlet(material: AudioMaterial, name: string): boolean {
  return material.audioInputs.includes(name);
}

export function isNoteInlet(name: string): boolean {
  return isControlJack(name) && (name === 'note' || name === 'gate' || name === 'velocity' || name === 'trig');
}

export function isCvInlet(material: AudioMaterial, name: string): boolean {
  return material.automatable.includes(name) && !isAudioInlet(material, name) && !isNoteInlet(name);
}

function walk(node: WalkNode, into: Set<string>, seen: Set<number>): void {
  if (seen.has(node.id)) return;
  seen.add(node.id);
  if (node.kind === 'param') {
    const name = String(node.params.name ?? '');
    if (CONTROL_PARAMS.has(name)) into.add(name);
  }
  for (const child of Object.values(node.inputs)) walk(child, into, seen);
  for (const child of node.list ?? []) walk(child, into, seen);
}
