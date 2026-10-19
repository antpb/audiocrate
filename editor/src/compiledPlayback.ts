/**
 * Whether a patch can be played the way the plugin plays it: flattened into
 * one graph and run as one voice.
 *
 * The patcher has two ways to play. The per-module one gives every module its
 * own worklet voice, wires cables between them as Web Audio connections, and
 * applies a cable into a parameter from the main thread, sampled every 50 ms
 * (`applyCv`). The compiled one lowers the whole patch with `flattenPatch`,
 * the same lowering Export Plugin and the iOS AUv3 use, so a cable into a
 * parameter is a per-sample signal inside the graph. A hi-hat's 26 ms
 * envelope, a 5 Hz wobble and a one-sample clock into a Euclidean are all
 * invisible to a 50 ms poll and exact in the compiled graph, and the compiled
 * graph is the one the plugin renders, so what the browser plays is what
 * ships.
 *
 * Compiled is the default. Per-module stays for what compiling cannot
 * express or would take away:
 *
 * - kernel DSP (Amp, Drum, NAM, IR), which `flattenPatch` refuses;
 * - modules that hold a file the editor loaded (a sample, a wavetable, an
 *   impulse), because flatten builds each module fresh from the catalog and
 *   the file lives on the editor's instance;
 * - the looper and the analysis modules, whose value is a readout in the
 *   inspector that a single compiled voice does not report per module;
 * - MIDI Out, spatial nodes and MIDI clips, which are host plumbing rather
 *   than graph;
 * - anything flatten refuses, which includes a patch mid-edit with nothing
 *   reaching Master.
 *
 * Pure, so the rule is testable without an AudioContext.
 */
import { DEFAULT_PATCH_IO, NOTE_INPUTS, detectPatchRole, flattenPatch, isLooperKind, planVoicing, type AudioMaterial } from '../../src/index';
import { isAnalysisKind } from './analysisKinds';
import { hasFileSlots } from './nodeAssets';
import type { CratePatch } from './patch';
import { resolveKind } from './pluginDoc';
import { isSpatialMasterKind, isSpatialSourceKind } from './spatialNodes';
import { isMidiClipKind, isMidiOutKind } from './tools';

/** The id the compiled voice is filed under among the live nodes. */
export const COMPILED_LIVE_ID = '__compiled';

/**
 * A refusal says which kind it is. `ineligible` is a module compiled playback
 * does not take (a kernel, a file, a looper): that patch plays per module.
 * `unflattenable` is a patch that does not lower right now, usually because
 * it is mid-edit with nothing reaching Master: a compiled voice already
 * playing keeps playing through that, as the plugin keeps its last good graph.
 */
export type CompiledPlan =
  | { ok: true; material: AudioMaterial; role: 'insert' | 'instrument' }
  | { ok: false; kind: 'ineligible' | 'unflattenable'; reason: string };

export interface CompiledPlanOptions {
  /**
   * Whether a node holds a file the editor loaded. Kinds with a file slot are
   * compiled only while the answer is no: a Wavetable on its factory frames
   * flattens exactly, one playing a loaded table would lose the table.
   */
  holdsFile?: (nodeId: string, kind: string) => boolean;
}

export function compiledPlan(patch: CratePatch, options: CompiledPlanOptions = {}): CompiledPlan {
  for (const node of patch.nodes) {
    const kind = node.kind;
    if (kind === 'drum') return { ok: false, kind: 'ineligible', reason: `${node.id} is a drum kit, which runs a kernel` };
    if (isLooperKind(kind)) return { ok: false, kind: 'ineligible', reason: `${node.id} is a looper` };
    if (isAnalysisKind(kind)) return { ok: false, kind: 'ineligible', reason: `${node.id} is an analysis module` };
    if (isSpatialSourceKind(kind) || isSpatialMasterKind(kind)) return { ok: false, kind: 'ineligible', reason: `${node.id} is spatial` };
    if (isMidiOutKind(kind)) return { ok: false, kind: 'ineligible', reason: `${node.id} is MIDI Out` };
    if (isMidiClipKind(kind)) return { ok: false, kind: 'ineligible', reason: `${node.id} is a MIDI clip` };
    if (hasFileSlots(kind) && (kind !== 'wavetable' || (options.holdsFile?.(node.id, kind) ?? true))) {
      return { ok: false, kind: 'ineligible', reason: `${node.id} holds a file` };
    }
  }
  const role = detectPatchRole(patch);
  try {
    const material = flattenPatch(patch, { resolve: resolveKind, role, name: 'Patch' });
    return { ok: true, material, role };
  } catch (err) {
    return { ok: false, kind: 'unflattenable', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What decides whether a running compiled voice has to be rebuilt: the
 * modules and the cables, not the values. A knob reaches the running voice as
 * a parameter change (`{nodeId}_{name}`, which is what flatten publishes), and
 * rebuilding on one would empty every delay line in the patch while somebody
 * turns it.
 */
export function compiledStructureKey(patch: CratePatch): string {
  // `voicing` changes which half of a split instrument a module runs in, so
  // it rebuilds the voice the way a new cable does.
  const nodes = patch.nodes.map((node) => `${node.id}:${node.kind}${node.voicing ? `:${node.voicing}` : ''}`).sort();
  const cables = patch.connections
    .map((conn) => `${conn.source}:${conn.sourceOutput}>${conn.target}:${conn.targetInput}`)
    .sort();
  return `${nodes.join(',')}|${cables.join(',')}`;
}

/** The compiled voice's name for one module's parameter. */
export function compiledParamName(nodeId: string, param: string): string {
  return `${nodeId}_${param}`;
}

/**
 * Where one module of an instrument runs, for the inspector's Per voice /
 * Summed switch, or undefined when the question does not arise: an insert,
 * a tool, or a module no voice reaches. The same `planVoicing` call
 * `flattenPatch` makes, so the switch shows what the voice will do.
 */
export function voicingView(
  patch: CratePatch,
  nodeId: string,
): { role: 'instanced' | 'summed'; canSum: boolean; reason?: string } | undefined {
  if (detectPatchRole(patch) !== 'instrument') return undefined;
  const io = new Set<string>(Object.values(DEFAULT_PATCH_IO));
  const materials = new Map<string, AudioMaterial>();
  for (const node of patch.nodes) {
    if (io.has(node.kind)) continue;
    const material = resolveKind(node.kind);
    if (material) materials.set(node.id, material);
  }
  if (!materials.has(nodeId)) return undefined;
  const plan = planVoicing({
    nodes: patch.nodes,
    connections: patch.connections,
    materials,
    voiceSourceKinds: new Set([DEFAULT_PATCH_IO.keyboard, DEFAULT_PATCH_IO.midiIn]),
    noteInputs: NOTE_INPUTS,
  });
  const role = plan.role.get(nodeId);
  if (!role || role === 'global') return undefined;
  const reason = plan.reason.get(nodeId);
  return { role, canSum: plan.canSum.get(nodeId) ?? false, ...(reason ? { reason } : {}) };
}
