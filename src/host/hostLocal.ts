/**
 * Hardware ports belong to the machine, not the session.
 *
 * Line capture, MIDI In, and MIDI Out device ids name a box on this
 * computer. Another participant's "KeyStep" or "BlackHole 2ch" is not a
 * port on yours. Those ids must not cross the collab wire. Channel,
 * message, and width on a MIDI node are patch settings and do sync.
 *
 * Line's capture device is not stored on the patch at all. MIDI `deviceId`
 * can sit in local node data so this machine remembers a port; strip it
 * before publish and overlay the local value after a remote patch lands.
 */
export const HOST_LOCAL_NODE_KEYS = ['deviceId'] as const;

export type HostLocalNodeKey = (typeof HOST_LOCAL_NODE_KEYS)[number];

export function isHostLocalNodeKey(key: string): boolean {
  return (HOST_LOCAL_NODE_KEYS as readonly string[]).includes(key);
}

export interface HostLocalPatchNode {
  id: string;
  data?: Record<string, unknown>;
}

export interface HostLocalPatch {
  nodes: readonly HostLocalPatchNode[];
}

export function omitHostLocalNodeData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return data;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isHostLocalNodeKey(key)) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  if (!changed) return data;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Local host-local keys win. Remote ones are ignored. */
export function overlayHostLocalNodeData(
  incoming: Record<string, unknown> | undefined,
  local: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!local) return incoming;
  let next: Record<string, unknown> | undefined;
  for (const key of HOST_LOCAL_NODE_KEYS) {
    if (!(key in local)) continue;
    if (!next) next = { ...(incoming ?? {}) };
    next[key] = local[key];
  }
  return next ?? incoming;
}

export function stripHostLocalPatch<T extends HostLocalPatch>(patch: T): T {
  let changed = false;
  const nodes = patch.nodes.map((node) => {
    const data = omitHostLocalNodeData(node.data);
    if (data === node.data) return node;
    changed = true;
    if (data === undefined) {
      const next = { ...node };
      delete next.data;
      return next;
    }
    return { ...node, data };
  });
  return changed ? { ...patch, nodes } : patch;
}

/**
 * Drop any remote device ids, then put this machine's back on matching
 * node ids. A new node has no local port yet, so it stays unset.
 */
export function restoreHostLocalPatch<T extends HostLocalPatch>(incoming: T, local: T): T {
  const stripped = stripHostLocalPatch(incoming);
  const byId = new Map(local.nodes.map((node) => [node.id, node]));
  let changed = stripped !== incoming;
  const nodes = stripped.nodes.map((node) => {
    const data = overlayHostLocalNodeData(node.data, byId.get(node.id)?.data);
    if (data === node.data) return node;
    changed = true;
    if (data === undefined) {
      const next = { ...node };
      delete next.data;
      return next;
    }
    return { ...node, data };
  });
  return changed ? { ...stripped, nodes } : incoming;
}
