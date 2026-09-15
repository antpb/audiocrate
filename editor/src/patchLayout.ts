import type { CratePatch } from './patch';

const COLUMN = 220;
const ROW = 150;
const ORIGIN_X = 40;
const ORIGIN_Y = 40;

/**
 * Places every node by its depth in the graph, the same way iOS
 * `CratePatchLayout.apply` and the generated-patch path do.
 */
export function applyPatchLayout(patch: CratePatch): CratePatch {
  const depth = new Map<string, number>();

  const visit = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached != null) return cached;
    if (seen.has(id)) return 0;
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const parents = patch.connections.filter((conn) => conn.target === id).map((conn) => conn.source);
    const value = parents.length === 0 ? 0 : Math.max(...parents.map((parent) => visit(parent, nextSeen))) + 1;
    depth.set(id, value);
    return value;
  };

  for (const node of patch.nodes) visit(node.id, new Set());

  const rows = new Map<number, number>();
  return {
    ...patch,
    nodes: patch.nodes.map((node) => {
      const column = depth.get(node.id) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return {
        ...node,
        x: ORIGIN_X + column * COLUMN,
        y: ORIGIN_Y + row * ROW,
      };
    }),
  };
}
