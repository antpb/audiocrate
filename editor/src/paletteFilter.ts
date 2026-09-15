import type { CatalogCategory, CatalogEntry } from './catalog';

export type PaletteFilter = 'all' | CatalogCategory;

export function matchesPaletteQuery(entry: CatalogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.label.toLowerCase().includes(q) ||
    entry.kind.toLowerCase().includes(q) ||
    entry.category.toLowerCase().includes(q) ||
    (entry.blurb ?? '').toLowerCase().includes(q)
  );
}

export function filterCatalog(
  entries: readonly CatalogEntry[],
  filter: PaletteFilter,
  query: string,
): CatalogEntry[] {
  return entries.filter((entry) => {
    if (filter !== 'all' && entry.category !== filter) return false;
    return matchesPaletteQuery(entry, query);
  });
}
