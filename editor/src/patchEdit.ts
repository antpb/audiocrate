import { stripHostLocalPatch, type SceneEdit, type SceneSync } from '../../src/index';
import { isCratePatch, parsePatch, type CratePatch } from './patch';

export type TransportAction = 'playing' | 'stopped';

export function patchFromEdit(edit: SceneEdit): CratePatch | null {
  if (edit.kind !== 'patch') return null;
  const json = edit.value.json;
  if (typeof json !== 'string') return null;
  try {
    const patch = parsePatch(json);
    return isCratePatch(patch) ? patch : null;
  } catch {
    return null;
  }
}

export function publishPatch(sync: SceneSync, patch: CratePatch): void {
  const wire = stripHostLocalPatch(patch);
  sync.sendEdit({
    target: 'patch',
    kind: 'patch',
    value: { json: JSON.stringify(wire) },
  });
}

export function publishTransport(sync: SceneSync, action: TransportAction): void {
  sync.sendEdit({
    target: 'transport',
    kind: 'transport',
    value: { action },
  });
}

export function transportActionFromEdit(edit: SceneEdit): TransportAction | null {
  if (edit.kind !== 'transport' || edit.target !== 'transport') return null;
  const action = edit.value.action;
  return action === 'playing' || action === 'stopped' ? action : null;
}
