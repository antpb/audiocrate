import { describe, expect, it } from 'vitest';
import { catalog } from '../src/catalog';
import { filterCatalog } from '../src/paletteFilter';

describe('filterCatalog', () => {
  it('returns the full palette when filter is all and query is empty', () => {
    expect(filterCatalog(catalog, 'all', '')).toHaveLength(catalog.length);
  });

  it('keeps one category and matches label or kind', () => {
    const analysis = filterCatalog(catalog, 'Analysis', '');
    expect(analysis.map((entry) => entry.kind).sort()).toEqual(['analyzer', 'meter', 'scope', 'tuner']);
    const tuners = filterCatalog(catalog, 'all', 'tun');
    expect(tuners.some((entry) => entry.kind === 'tuner')).toBe(true);
    expect(filterCatalog(catalog, 'Time', 'loop').some((entry) => entry.kind === 'looper')).toBe(true);
  });
});
