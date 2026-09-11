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

const CONTROL_PARAMS = new Set(['note', 'gate', 'velocity']);
const MAX_CV_JACKS = 10;

/** note/gate/velocity on instrument graphs, plus automatable params as CV. */
export function controlInputs(material: AudioMaterial): string[] {
  const names = new Set<string>();
  walk(material.graph.output as WalkNode, names, new Set());
  if (material.polyphony > 1 || material.kind === 'synth' || material.kind === 'grain') {
    names.add('note');
    names.add('gate');
    names.add('velocity');
  }
  return ['note', 'gate', 'velocity'].filter((name) => names.has(name));
}

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
  return material.cvPolarity === 'unipolar' || material.kind === 'lfo' ? ['cv'] : ['audio'];
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
