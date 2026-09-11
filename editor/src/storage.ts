import { isCratePatch, starterPatch, type CratePatch } from './patch';

export const STORAGE_KEY = 'crate.patcher.v1';
/** Line capture device. Host-local. Not written into crate.patch or a session. */
export const LINE_DEVICE_KEY = 'crate.patcher.lineDevice';

export function normalizeLineDeviceId(id: string | null | undefined): string | null {
  if (!id || id === 'default' || id === 'communications') return null;
  return id;
}

export function loadLineDeviceId(store: Pick<Storage, 'getItem'> = localStorage): string | null {
  try {
    return normalizeLineDeviceId(store.getItem(LINE_DEVICE_KEY));
  } catch {
    return null;
  }
}

export function saveLineDeviceId(
  id: string | null,
  store: Pick<Storage, 'setItem' | 'removeItem'> = localStorage,
): void {
  const next = normalizeLineDeviceId(id);
  if (!next) store.removeItem(LINE_DEVICE_KEY);
  else store.setItem(LINE_DEVICE_KEY, next);
}

export function loadStoredPatch(): CratePatch {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return starterPatch();
    const parsed = JSON.parse(raw) as unknown;
    if (isCratePatch(parsed)) return parsed;
  } catch {
    /* ignore a corrupt slot */
  }
  return starterPatch();
}

export function saveStoredPatch(patch: CratePatch): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(patch));
}

export function clearStoredPatch(): void {
  localStorage.removeItem(STORAGE_KEY);
}
