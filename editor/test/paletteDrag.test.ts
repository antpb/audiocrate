import { describe, expect, it } from 'vitest';
import { graphPointFromHolder, isPaletteDrag, readPaletteKind, writePaletteKind } from '../src/paletteDrag';

function transfer(): DataTransfer {
  const data = new Map<string, string>();
  const types: string[] = [];
  return {
    types,
    effectAllowed: 'none',
    setData(type: string, value: string) {
      data.set(type, value);
      if (!types.includes(type)) types.push(type);
    },
    getData(type: string) {
      return data.get(type) ?? '';
    },
  } as DataTransfer;
}

describe('palette drag', () => {
  it('round-trips a kind and reports an active drag', () => {
    const data = transfer();
    writePaletteKind(data, 'tuner');
    expect(isPaletteDrag(data)).toBe(true);
    expect(readPaletteKind(data)).toBe('tuner');
  });

  it('maps a drop onto the holder into graph space', () => {
    const holder = {
      getBoundingClientRect: () => ({ left: 100, top: 40 }) as DOMRect,
    };
    expect(graphPointFromHolder(holder, 2, 164, 80)).toEqual({ x: 32, y: 20 });
  });
});
