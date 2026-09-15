import { useEffect, useRef, useState } from 'react';
import {
  FACTORY_PATCHES,
  factoryPatchById,
  groupedFactoryPatches,
  type FactoryPatch,
} from './factoryPatches';
import { listUserLibrary, type UserLibraryEntry } from './userLibrary';

type LibraryTab = 'factory' | 'mine';

interface LibraryPanelProps {
  open: boolean;
  currentFactory: string;
  currentUser: string;
  suggestedSaveName: string;
  onClose: () => void;
  onLoadFactory: (id: string) => void;
  onLoadUser: (entry: UserLibraryEntry) => void;
  onSave: (name: string) => void | Promise<void>;
  onImport: (file: File) => void | Promise<void>;
  onDelete: (filename: string) => void;
  onReset: () => void;
}

export function LibraryPanel({
  open,
  currentFactory,
  currentUser,
  suggestedSaveName,
  onClose,
  onLoadFactory,
  onLoadUser,
  onSave,
  onImport,
  onDelete,
  onReset,
}: LibraryPanelProps) {
  const [tab, setTab] = useState<LibraryTab>('factory');
  const [factoryCategory, setFactoryCategory] = useState<string | null>(null);
  const [saveName, setSaveName] = useState(suggestedSaveName);
  const [isEditing, setIsEditing] = useState(false);
  const [entries, setEntries] = useState<UserLibraryEntry[]>([]);
  const importRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setSaveName(suggestedSaveName);
    setEntries(listUserLibrary());
  }, [open, suggestedSaveName]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sections = groupedFactoryPatches().filter(
    (section) => factoryCategory == null || section.category === factoryCategory,
  );
  const categories = groupedFactoryPatches().map((section) => section.category);
  const canSave = saveName.trim().length > 0;

  function refresh() {
    setEntries(listUserLibrary());
  }

  return (
    <div className="library-wrap">
      <button type="button" className="library-dim" aria-label="Close library" onClick={onClose} />
      <aside className="library-modal" role="dialog" aria-labelledby="library-title">
        <header className="library-head">
          <h2 id="library-title">Library</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="library-tabs">
          <button type="button" className={tab === 'factory' ? 'on' : ''} onClick={() => setTab('factory')}>
            Factory
          </button>
          <button type="button" className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>
            Yours
          </button>
        </div>
        {tab === 'factory' ? (
          <div className="library-body">
            <div className="library-pills">
              <button type="button" className={factoryCategory == null ? 'on' : ''} onClick={() => setFactoryCategory(null)}>
                All
              </button>
              {categories.map((category) => (
                <button
                  key={category}
                  type="button"
                  className={factoryCategory === category ? 'on' : ''}
                  onClick={() => setFactoryCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>
            {sections.length === 0 ? (
              <p className="library-note">
                No factory patches for this slot, which should not happen. Import one instead.
              </p>
            ) : (
              <div className="library-list">
                {sections.map((section) => (
                  <section key={section.category}>
                    <h3>{section.category}</h3>
                    {section.patches.map((entry) => (
                      <FactoryRow
                        key={entry.id}
                        entry={entry}
                        current={entry.id === currentFactory}
                        onLoad={() => onLoadFactory(entry.id)}
                      />
                    ))}
                  </section>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="library-body">
            <div className="library-save">
              <input
                type="text"
                value={saveName}
                placeholder="Name this patch"
                spellCheck={false}
                autoCorrect="off"
                onChange={(event) => setSaveName(event.target.value)}
              />
              <button
                type="button"
                className="library-primary"
                disabled={!canSave}
                onClick={() => {
                  void Promise.resolve(onSave(saveName)).then(refresh);
                }}
              >
                Save
              </button>
              <button type="button" onClick={() => importRef.current?.click()}>
                Import
              </button>
            </div>
            {entries.length === 0 ? (
              <p className="library-note">
                Nothing saved yet. Name the patch on the canvas and press Save, or import a .crate.patch
                or .crate.plugin from elsewhere.
              </p>
            ) : (
              <>
                <div className="library-edit-row">
                  <button type="button" className={isEditing ? 'on' : ''} onClick={() => setIsEditing((value) => !value)}>
                    {isEditing ? 'Done' : 'Edit'}
                  </button>
                </div>
                <div className="library-list">
                  {entries.map((entry) => (
                    <div key={entry.filename} className="library-saved">
                      <button
                        type="button"
                        className="library-row"
                        disabled={!entry.isRunnable}
                        onClick={() => {
                          if (entry.isRunnable) onLoadUser(entry);
                        }}
                      >
                        <span className={`library-dot${entry.filename === currentUser ? ' on' : ''}`} />
                        <span className="library-copy">
                          <strong>{entry.label}</strong>
                          <em>{entry.summary}</em>
                        </span>
                      </button>
                      {isEditing ? (
                        <button
                          type="button"
                          className="danger"
                          onClick={() => {
                            onDelete(entry.filename);
                            refresh();
                          }}
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </>
            )}
            <button type="button" onClick={onReset}>
              Back to the built-in patch
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".json,.patch,.plugin,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void Promise.resolve(onImport(file)).then(refresh);
                event.target.value = '';
              }}
            />
          </div>
        )}
        <p className="library-count">
          {FACTORY_PATCHES.length} factory patches
          {currentFactory
            ? ` · ${factoryPatchById(currentFactory)?.name ?? currentFactory}`
            : ''}
        </p>
      </aside>
    </div>
  );
}

function FactoryRow({
  entry,
  current,
  onLoad,
}: {
  entry: FactoryPatch;
  current: boolean;
  onLoad: () => void;
}) {
  return (
    <button type="button" className="library-row" onClick={onLoad}>
      <span className={`library-dot${current ? ' on' : ''}`} />
      <span className="library-copy">
        <strong>{entry.name}</strong>
        <em>{entry.blurb}</em>
      </span>
    </button>
  );
}
