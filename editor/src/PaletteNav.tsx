import { catalog, categories, type CatalogCategory } from './catalog';
import { writePaletteKind } from './paletteDrag';
import { filterCatalog, type PaletteFilter } from './paletteFilter';

interface Props {
  filter: PaletteFilter;
  query: string;
  onFilter: (filter: PaletteFilter) => void;
  onQuery: (query: string) => void;
  onAdd: (kind: string) => void;
}

const PILLS: { id: PaletteFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  ...categories().map((category) => ({ id: category, label: category })),
];

export function PaletteNav({ filter, query, onFilter, onQuery, onAdd }: Props) {
  const visible = filterCatalog(catalog, filter, query);
  const groups = new Map<CatalogCategory, typeof visible>();
  for (const entry of visible) {
    const list = groups.get(entry.category) ?? [];
    list.push(entry);
    groups.set(entry.category, list);
  }

  return (
    <nav className="palette">
      <input
        className="palette-search"
        type="search"
        value={query}
        placeholder="Search materials"
        onChange={(event) => onQuery(event.target.value)}
      />
      <div className="palette-pills">
        {PILLS.map((pill) => (
          <button
            key={pill.id}
            type="button"
            className={filter === pill.id ? 'on' : ''}
            onClick={() => onFilter(pill.id)}
          >
            {pill.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? <p className="palette-empty">No materials match.</p> : null}
      {categories()
        .filter((category) => groups.has(category))
        .map((category) => (
          <section key={category}>
            <h3>{category}</h3>
            {(groups.get(category) ?? []).map((entry) => (
              <button
                key={entry.kind}
                type="button"
                draggable
                onDragStart={(event) => writePaletteKind(event.dataTransfer, entry.kind)}
                onClick={() => onAdd(entry.kind)}
              >
                {entry.label}
              </button>
            ))}
          </section>
        ))}
    </nav>
  );
}
