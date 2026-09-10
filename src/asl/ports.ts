/**
 * Which live audio inputs a graph actually reads.
 *
 * Both realms derive this from the same graph data rather than one telling
 * the other: `WebAudioRenderer` needs it on the main thread to size the
 * worklet node's `numberOfInputs`, and the processor needs it on the audio
 * thread to know which `inputs[k]` is which name. Sending it across as an
 * option would create two sources of truth for the same fact, and a
 * mismatch there is silent (a sidechain wired to the wrong port sounds like
 * a compressor that just does not work).
 *
 * The order is sorted, not discovery order, so it cannot depend on how a
 * builder happened to walk its own tree.
 */
import type { ASLGraphDescriptor } from './graph';
import type { ASLNode } from './types';
import { MAIN_PORT } from './builders';

function walk(node: ASLNode, into: Set<string>, seen: Set<number>): void {
  if (seen.has(node.id)) return;
  seen.add(node.id);
  if (node.kind === 'port') into.add(node.params.name as string);
  for (const child of Object.values(node.inputs)) walk(child, into, seen);
  for (const child of node.list ?? []) walk(child, into, seen);
}

/** Every port name the graph reads, including `input`, sorted. */
export function audioPortNames(graph: ASLGraphDescriptor): readonly string[] {
  const names = new Set<string>();
  walk(graph.output, names, new Set());
  return [...names].sort();
}

/**
 * Ports beyond the main insert input, in the order they are wired to a
 * renderer's audio inputs. `input` is always index 0 and is excluded here,
 * so `auxAudioPorts(graph)[i]` is the port on input `i + 1`.
 */
export function auxAudioPorts(graph: ASLGraphDescriptor): readonly string[] {
  return audioPortNames(graph).filter((name) => name !== MAIN_PORT);
}
