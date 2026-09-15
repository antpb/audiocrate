import { describe, expect, it } from 'vitest';
import { stringifyPatch, starterPatch } from '../src/patch';
import {
  USER_LIBRARY_KEY,
  deleteUserEntry,
  importUserDocument,
  labelFromFilename,
  listUserLibrary,
  patchFromUserEntry,
  saveUserPatch,
} from '../src/userLibrary';

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: (key: string) => {
      delete data[key];
    },
    data,
  };
}

describe('user library', () => {
  it('saves a named patch and replaces a second save under the same name', () => {
    const store = memoryStore();
    const first = saveUserPatch(starterPatch(), 'Bass', store);
    expect(first.filename).toBe('Bass.crate.patch');
    expect(first.summary).toMatch(/editable/);
    const second = saveUserPatch(starterPatch(), 'Bass', store);
    expect(listUserLibrary(store)).toHaveLength(1);
    expect(second.filename).toBe(first.filename);
    expect(patchFromUserEntry(second).kind).toBe('crate.patch');
  });

  it('imports a crate.patch by filename and refuses an empty name', () => {
    const store = memoryStore();
    const entry = importUserDocument(stringifyPatch(starterPatch()), 'Warm Pad.crate.patch', store);
    expect(entry.label).toBe('Warm Pad');
    expect(listUserLibrary(store)[0]?.filename).toBe('Warm Pad.crate.patch');
    expect(() => saveUserPatch(starterPatch(), '   ', store)).toThrow(/name/i);
    expect(labelFromFilename('Deep Sub.crate.patch')).toBe('Deep Sub');
  });

  it('deletes by filename', () => {
    const store = memoryStore();
    const entry = saveUserPatch(starterPatch(), 'Temp', store);
    deleteUserEntry(entry.filename, store);
    expect(listUserLibrary(store)).toEqual([]);
    expect(store.data[USER_LIBRARY_KEY]).toBe('[]');
  });
});
