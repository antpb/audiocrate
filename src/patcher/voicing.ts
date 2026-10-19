/**
 * Which modules of an instrument patch run once per voice and which run once
 * on the sum of all voices.
 *
 * A patch is modular-synth topology: a keyboard plays eight oscillator voices
 * into one reverb. The per-module patcher always meant it that way (a module
 * with polyphony 1 is one module, and every voice cabled into it is mixed at
 * its input). Flattening used to copy the whole chain into every voice, so a
 * flattened instrument ran eight reverbs and eight limiters, cost eight times
 * as much, and limited each note on its own instead of the chord. This file
 * restores the patch's meaning, and `flattenPatch` builds from its answer.
 *
 * A module is **per voice** (`instanced`) when it has to know which voice it
 * is in:
 *
 *  - it is a voice source: its material's polyphony is above 1;
 *  - its graph reads the voice: a `note` / `velocity` param it does not
 *    declare, or a node that follows the voice's gate (`VOICE_GATE_KINDS`);
 *  - a Keyboard or MIDI In cable lands on it;
 *  - a per-voice signal drives one of its non-audio inputs (an envelope into
 *    a filter's cutoff makes that filter per voice);
 *  - per-voice signals reach two or more of its audio inputs: a ring
 *    modulator multiplying two summed inputs would multiply every voice by
 *    every other, so a module that combines inputs combines them per voice;
 *  - it feeds anything per voice (a summed signal has no voices left to hand
 *    on), to a fixpoint;
 *  - the patch says so: `voicing: 'instanced'` on the node.
 *
 * Anything else downstream of a voice is **summed**: its audio inputs from
 * the voice side are the sum over voices, and it runs once. A module nothing
 * per-voice reaches (an LFO, a transport readout) is **global**, and is built
 * into whichever half reads it.
 *
 * Mirrored in `CrateASL/VoicingPlan.swift`. Both must answer the same, which
 * `fixtures/flatten-conformance.json` holds them to.
 */
import type { AudioMaterial } from '../graph/AudioMaterial';
import type { ASLNode } from '../asl/types';

export type Voicing = 'instanced' | 'summed';
export type VoicingRole = 'instanced' | 'summed' | 'global';

/** Node kinds that read the voice's gate when nothing is cabled into theirs. */
export const VOICE_GATE_KINDS: ReadonlySet<string> = new Set(['adsr', 'dahdsr', 'breakpoints', 'impulse', 'samplePlay']);

/** Params a voice sets on every note, which a module reads to know its voice. */
const VOICE_PARAMS: ReadonlySet<string> = new Set(['note', 'velocity', 'gate']);

export interface VoicingNode {
  id: string;
  kind: string;
  voicing?: Voicing;
}

export interface VoicingConnection {
  source: string;
  sourceOutput: string;
  target: string;
  targetInput: string;
}

export interface VoicingInputs {
  nodes: readonly VoicingNode[];
  connections: readonly VoicingConnection[];
  /** Built materials by node id, I/O nodes absent. */
  materials: ReadonlyMap<string, AudioMaterial>;
  /** Kinds that are a per-note source: the keyboard and MIDI In. */
  voiceSourceKinds: ReadonlySet<string>;
  /** Inlets a note source drives (`NOTE_INPUTS` in flattenPatch). */
  noteInputs: ReadonlySet<string>;
}

export interface VoicingPlan {
  role: ReadonlyMap<string, VoicingRole>;
  /**
   * Whether a node could be summed if nobody asked otherwise: true for a
   * summed node and for an instanced one that is only instanced because the
   * patch (or a node downstream of it) says `voicing: 'instanced'`. What the
   * inspector's toggle is enabled by.
   */
  canSum: ReadonlyMap<string, boolean>;
  /** Why a node that cannot be summed is per voice, for the inspector. */
  reason: ReadonlyMap<string, string>;
}

/** Whether a material's own graph reads the voice it is in. */
export function readsVoice(material: AudioMaterial): boolean {
  const declared = material.params;
  const seen = new Set<number>();
  let found = false;
  const walk = (node: ASLNode): void => {
    if (found || seen.has(node.id)) return;
    seen.add(node.id);
    if (VOICE_GATE_KINDS.has(node.kind)) {
      found = true;
      return;
    }
    if (node.kind === 'param') {
      const name = String(node.params.name ?? '');
      if (VOICE_PARAMS.has(name) && !(name in declared)) {
        found = true;
        return;
      }
    }
    for (const child of Object.values(node.inputs)) walk(child);
    for (const child of node.list ?? []) walk(child);
  };
  walk(material.graph.output);
  return found;
}

export function planVoicing(input: VoicingInputs): VoicingPlan {
  const { nodes, connections, materials, voiceSourceKinds, noteInputs } = input;
  const kinds = new Map(nodes.map((node) => [node.id, node.kind]));
  const flags = new Map(nodes.map((node) => [node.id, node.voicing]));
  const ids = nodes.map((node) => node.id).filter((id) => materials.has(id));

  /** Whether `inlet` on `id` carries audio (summable) rather than control. */
  const isAudioInlet = (id: string, inlet: string): boolean => materials.get(id)!.audioInputs.includes(inlet);
  /** Edges that order evaluation, the same filter as flatten's topological sort. */
  const relevant = (conn: VoicingConnection): boolean => {
    const target = materials.get(conn.target);
    if (!target) return false;
    return (
      target.audioInputs.includes(conn.targetInput) ||
      conn.targetInput in target.params ||
      noteInputs.has(conn.targetInput)
    );
  };
  const fromVoiceSource = (conn: VoicingConnection): boolean => voiceSourceKinds.has(kinds.get(conn.source) ?? '');

  const inherentReason = new Map<string, string>();
  for (const id of ids) {
    const material = materials.get(id)!;
    if (material.polyphony > 1) inherentReason.set(id, 'it is a voice: one per note');
    else if (readsVoice(material)) inherentReason.set(id, 'it reads the note, velocity or gate of its voice');
  }
  for (const conn of connections) {
    if (!materials.has(conn.target) || !fromVoiceSource(conn)) continue;
    if (!inherentReason.has(conn.target)) inherentReason.set(conn.target, 'the keyboard plays it directly');
  }

  // Downstream of a voice at all. Iterated to a fixpoint rather than sorted,
  // so a document whose cables are listed in any order gets one answer.
  const derives = new Set<string>(inherentReason.keys());
  for (let changed = true; changed; ) {
    changed = false;
    for (const conn of connections) {
      if (!relevant(conn) || derives.has(conn.target)) continue;
      if (derives.has(conn.source)) {
        derives.add(conn.target);
        changed = true;
      }
    }
  }

  /** Per voice, honouring the patch's flags or not. */
  const instancedSet = (honourFlags: boolean): { set: Set<string>; reason: Map<string, string> } => {
    const set = new Set<string>(inherentReason.keys());
    const reason = new Map(inherentReason);
    for (const conn of connections) {
      if (!relevant(conn) || !derives.has(conn.source) || set.has(conn.target)) continue;
      if (!isAudioInlet(conn.target, conn.targetInput) || noteInputs.has(conn.targetInput)) {
        set.add(conn.target);
        reason.set(conn.target, `a per-voice signal drives its ${conn.targetInput}`);
      }
    }
    // Voice signals on two or more audio inlets do not sum: combining two
    // sums (a product, a crossfade, a sidechain) mixes voices into each other.
    const voicedInlets = new Map<string, Set<string>>();
    for (const conn of connections) {
      if (!relevant(conn) || !derives.has(conn.source) || !isAudioInlet(conn.target, conn.targetInput)) continue;
      const inlets = voicedInlets.get(conn.target) ?? new Set<string>();
      inlets.add(conn.targetInput);
      voicedInlets.set(conn.target, inlets);
    }
    for (const [id, inlets] of voicedInlets) {
      if (inlets.size >= 2 && !set.has(id)) {
        set.add(id);
        reason.set(id, 'it combines per-voice signals on more than one input');
      }
    }
    if (honourFlags) {
      for (const id of ids) {
        if (derives.has(id) && flags.get(id) === 'instanced' && !set.has(id)) {
          set.add(id);
          reason.set(id, 'set to run per voice');
        }
      }
    }
    // A summed signal cannot feed anything per voice: the voices are gone.
    for (let changed = true; changed; ) {
      changed = false;
      for (const conn of connections) {
        if (!relevant(conn) || !set.has(conn.target)) continue;
        if (derives.has(conn.source) && materials.has(conn.source) && !set.has(conn.source)) {
          set.add(conn.source);
          reason.set(conn.source, `it feeds ${conn.target}, which runs per voice`);
          changed = true;
        }
      }
    }
    return { set, reason };
  };

  const honoured = instancedSet(true);
  const forced = instancedSet(false);

  const role = new Map<string, VoicingRole>();
  const canSum = new Map<string, boolean>();
  const reason = new Map<string, string>();
  for (const id of ids) {
    if (!derives.has(id)) {
      role.set(id, 'global');
      canSum.set(id, false);
      reason.set(id, 'no voice reaches it, so it runs once already');
      continue;
    }
    role.set(id, honoured.set.has(id) ? 'instanced' : 'summed');
    canSum.set(id, !forced.set.has(id));
    const why = forced.reason.get(id) ?? honoured.reason.get(id);
    if (why && honoured.set.has(id)) reason.set(id, why);
  }
  return { role, canSum, reason };
}
