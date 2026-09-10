import { describe, expect, it } from 'vitest';
import { LINE_DEVICE_KEY, loadLineDeviceId, normalizeLineDeviceId, saveLineDeviceId } from '../src/storage';

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

describe('line device storage', () => {
  it('treats default and communications aliases as unset', () => {
    expect(normalizeLineDeviceId(null)).toBeNull();
    expect(normalizeLineDeviceId('')).toBeNull();
    expect(normalizeLineDeviceId('default')).toBeNull();
    expect(normalizeLineDeviceId('communications')).toBeNull();
    expect(normalizeLineDeviceId('abc')).toBe('abc');
  });

  it('round-trips a real device id', () => {
    const store = memoryStore();
    saveLineDeviceId('iface-1', store);
    expect(store.data[LINE_DEVICE_KEY]).toBe('iface-1');
    expect(loadLineDeviceId(store)).toBe('iface-1');
  });

  it('clears default and missing values', () => {
    const store = memoryStore({ [LINE_DEVICE_KEY]: 'iface-1' });
    saveLineDeviceId('default', store);
    expect(loadLineDeviceId(store)).toBeNull();
    expect(store.data[LINE_DEVICE_KEY]).toBeUndefined();
  });
});
