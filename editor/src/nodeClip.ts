import type { PatchNode } from './patch';

export const NODE_CLIP_KIND = 'crate.nodeclip';
export const NODE_CLIP_VERSION = 1;
export const PASTE_NUDGE = 36;

export function stringifyNodeClip(node: PatchNode): string {
  return JSON.stringify(
    {
      version: NODE_CLIP_VERSION,
      kind: NODE_CLIP_KIND,
      node: {
        kind: node.kind,
        x: node.x,
        y: node.y,
        params: node.params,
        ...(node.data ? { data: node.data } : {}),
      },
    },
    null,
    2,
  );
}

export function parseNodeClip(text: string): PatchNode | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const doc = parsed as Record<string, unknown>;
  if (doc.kind !== NODE_CLIP_KIND) return null;
  const raw = doc.node;
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  if (typeof node.kind !== 'string' || !node.kind) return null;
  const params =
    node.params && typeof node.params === 'object' && !Array.isArray(node.params)
      ? (node.params as Record<string, number>)
      : {};
  const data =
    node.data && typeof node.data === 'object' && !Array.isArray(node.data)
      ? (node.data as Record<string, unknown>)
      : undefined;
  return {
    id: typeof node.id === 'string' ? node.id : '',
    kind: node.kind,
    x: typeof node.x === 'number' && Number.isFinite(node.x) ? node.x : 0,
    y: typeof node.y === 'number' && Number.isFinite(node.y) ? node.y : 0,
    params,
    ...(data ? { data } : {}),
  };
}

export function pasteOffset(x: number, y: number, generation: number): { x: number; y: number } {
  const step = PASTE_NUDGE * Math.max(1, generation);
  return { x: x + step, y: y + step };
}
