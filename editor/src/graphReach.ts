import { isAnalysisKind } from './analysisKinds';
import { isMasterKind, isMidiOutKind } from './tools';

export interface ReachNode {
  id: string;
  kind: string;
}

export interface ReachConn {
  source: string;
  target: string;
}

function idsReaching(
  nodes: readonly ReachNode[],
  connections: readonly ReachConn[],
  isSink: (kind: string) => boolean,
  requireIncoming = false,
): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const conn of connections) {
    const list = incoming.get(conn.target);
    if (list) list.push(conn.source);
    else incoming.set(conn.target, [conn.source]);
  }
  const seen = new Set<string>();
  const stack = nodes
    .filter((node) => isSink(node.kind) && (!requireIncoming || incoming.has(node.id)))
    .map((node) => node.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const sources = incoming.get(id);
    if (sources) for (const source of sources) stack.push(source);
  }
  return seen;
}

/** Nodes that can change what Master hears, walking cables backward. */
export function idsReachingMaster(nodes: readonly ReachNode[], connections: readonly ReachConn[]): Set<string> {
  return idsReaching(nodes, connections, isMasterKind);
}

/** MIDI Out is a sink. Isolated MIDI Out nodes stay dark until something feeds them. */
export function idsReachingMidiOut(nodes: readonly ReachNode[], connections: readonly ReachConn[]): Set<string> {
  return idsReaching(nodes, connections, isMidiOutKind, true);
}

/** Analysis inserts that are fed, plus everything upstream of them. */
export function idsFeedingAnalysis(nodes: readonly ReachNode[], connections: readonly ReachConn[]): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const conn of connections) {
    const list = incoming.get(conn.target);
    if (list) list.push(conn.source);
    else incoming.set(conn.target, [conn.source]);
  }
  const seen = new Set<string>();
  const stack = nodes.filter((node) => isAnalysisKind(node.kind) && incoming.has(node.id)).map((node) => node.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const sources = incoming.get(id);
    if (sources) for (const source of sources) stack.push(source);
  }
  return seen;
}

/** Worklets worth creating: the mix path, analysis that has a source, MIDI Out that is fed. */
export function liveNodeIds(nodes: readonly ReachNode[], connections: readonly ReachConn[]): Set<string> {
  const live = idsReachingMaster(nodes, connections);
  for (const id of idsFeedingAnalysis(nodes, connections)) live.add(id);
  for (const id of idsReachingMidiOut(nodes, connections)) live.add(id);
  return live;
}
