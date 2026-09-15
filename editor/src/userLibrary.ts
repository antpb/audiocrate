import { parseCratePlugin } from '../../src/index';
import { isCratePatch, parsePatch, stringifyPatch, type CratePatch } from './patch';

export const USER_LIBRARY_KEY = 'crate.patcher.library.v1';

export interface UserLibraryEntry {
  kind: 'plugin' | 'patch';
  filename: string;
  label: string;
  id: string;
  role: string;
  parameterCount: number;
  isRunnable: boolean;
  summary: string;
  modified: number;
  document: unknown;
}

export interface UserLibraryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storeOf(store?: UserLibraryStore): UserLibraryStore {
  return store ?? localStorage;
}

function compiledParamCount(params: unknown): number {
  if (!params || typeof params !== 'object') return 0;
  return Object.keys(params).length;
}

function safe(label: string): string {
  const cleaned = [...label].map((character) =>
    /[A-Za-z0-9 -]/.test(character) ? character : '-',
  );
  return cleaned.join('').trim();
}

export function labelFromFilename(filename: string): string {
  let name = filename;
  for (const suffix of ['.crate.patch', '.crate.plugin', '.patch', '.plugin', '.json']) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return name.length === 0 ? filename : name;
}

function readAll(store: UserLibraryStore): UserLibraryEntry[] {
  try {
    const raw = store.getItem(USER_LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).sort((a, b) => b.modified - a.modified);
  } catch {
    return [];
  }
}

function writeAll(entries: UserLibraryEntry[], store: UserLibraryStore): void {
  store.setItem(USER_LIBRARY_KEY, JSON.stringify(entries));
}

function isEntry(value: unknown): value is UserLibraryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as UserLibraryEntry;
  return (
    (entry.kind === 'patch' || entry.kind === 'plugin') &&
    typeof entry.filename === 'string' &&
    typeof entry.label === 'string' &&
    typeof entry.document === 'object'
  );
}

export function listUserLibrary(store?: UserLibraryStore): UserLibraryEntry[] {
  return readAll(storeOf(store));
}

export function saveUserPatch(patch: CratePatch, label: string, store?: UserLibraryStore): UserLibraryEntry {
  const trimmed = label.trim();
  if (!trimmed) throw new Error('Give the patch a name first.');
  const filename = `${safe(trimmed)}.crate.patch`;
  const entry: UserLibraryEntry = {
    kind: 'patch',
    filename,
    label: trimmed,
    id: trimmed,
    role: 'patch',
    parameterCount: patch.nodes.length,
    isRunnable: true,
    summary: `${patch.nodes.length} modules · ${patch.connections.length} cables · editable`,
    modified: Date.now(),
    document: patch,
  };
  const next = readAll(storeOf(store)).filter((item) => item.filename !== filename);
  next.unshift(entry);
  writeAll(next, storeOf(store));
  return entry;
}

export function importUserDocument(text: string, filename: string, store?: UserLibraryStore): UserLibraryEntry {
  try {
    const patch = parsePatch(text);
    return saveUserPatch(patch, labelFromFilename(filename), store);
  } catch {
    /* try plugin next */
  }

  const doc = parseCratePlugin(text);
  const patch = doc.patch as CratePatch;
  const runnable = isCratePatch(patch);
  const entry: UserLibraryEntry = {
    kind: 'plugin',
    filename: `${safe(doc.id)}.crate.plugin`,
    label: doc.label,
    id: doc.id,
    role: doc.role,
    parameterCount: compiledParamCount(doc.compiled?.params) || patch.nodes.length,
    isRunnable: runnable,
    summary: runnable
      ? `${doc.role} · ${compiledParamCount(doc.compiled?.params) || patch.nodes.length} parameters · compiled`
      : 'no compiled graph, re-export it',
    modified: Date.now(),
    document: JSON.parse(text),
  };
  const next = readAll(storeOf(store)).filter((item) => item.filename !== entry.filename);
  next.unshift(entry);
  writeAll(next, storeOf(store));
  return entry;
}

export function deleteUserEntry(filename: string, store?: UserLibraryStore): void {
  writeAll(
    readAll(storeOf(store)).filter((entry) => entry.filename !== filename),
    storeOf(store),
  );
}

export function patchFromUserEntry(entry: UserLibraryEntry): CratePatch {
  if (entry.kind === 'patch') {
    if (!isCratePatch(entry.document)) throw new Error('Saved patch is not a crate.patch document');
    return entry.document;
  }
  const doc = entry.document as { patch?: unknown };
  if (!isCratePatch(doc.patch)) throw new Error('That plugin has no editable patch.');
  return doc.patch;
}

export function exportUserEntryBytes(entry: UserLibraryEntry): string {
  if (entry.kind === 'patch' && isCratePatch(entry.document)) {
    return stringifyPatch(entry.document);
  }
  return JSON.stringify(entry.document, null, 2);
}
