import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorScreen } from './components/EditorScreen';
import { MapLibrary } from './components/MapLibrary';
import { ReplayImportDialog, type ReplaySource } from './components/ReplayImportDialog';
import { uiAssets } from './lib/assets';
import { setCanvasSize } from './lib/constants';
import { mapStore } from './lib/storage';
import type { StoredMap } from './lib/types';
import './styles.css';
import './library.css';

declare global {
  interface Window {
    __mapEditorConfirmLeave?: () => Promise<boolean>;
  }
}

/** How long a deleted map can be brought back before its files are removed. */
const UNDO_DELETE_MS = 5000;

interface PendingDelete {
  ids: string[];
  label: string;
  timer: number;
}

type Screen =
  | { kind: 'library' }
  | { kind: 'editor'; mapId: string };

/** The page around the editor, outside its scoped styles, where the Replays
 * page keeps its docks and dialogs and their shared colors are defined. */
function portalHost() {
  return document.querySelector<HTMLElement>('.map-editor-page') ?? document.body;
}

function upsertMap(collection: StoredMap[], nextMap: StoredMap) {
  return [nextMap, ...collection.filter((map) => map.id !== nextMap.id)].sort((left, right) => right.updatedAt - left.updatedAt);
}

export default function MapEditorApp() {
  const [maps, setMaps] = useState<StoredMap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [screen, setScreen] = useState<Screen>({ kind: 'library' });
  // A new map has no file until its first save, so it is kept here, not in the list.
  const [newMap, setNewMap] = useState<StoredMap | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  // Map codes imported this session; the dialog marks them so more codes can be added.
  const [importedCodes, setImportedCodes] = useState<ReadonlySet<string>>(() => new Set());
  // The terrain of every map in the library: a map hub map with the same terrain
  // is already imported, from this session or an earlier one.
  // Maps waiting out the undo window are hidden from the library but still on disk.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const pendingDeleteRef = useRef<PendingDelete | null>(null);
  const shownMaps = useMemo(() => {
    if (!pendingDelete) return maps;
    const hidden = new Set(pendingDelete.ids);
    return maps.filter((map) => !hidden.has(map.id));
  }, [maps, pendingDelete]);
  const librarySurfaces = useMemo(() => new Set(shownMaps.map((map) => map.data.map_surface)), [shownMaps]);
  const leaveGuardRef = useRef<(() => Promise<boolean>) | null>(null);

  useEffect(() => {
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link');
    favicon.rel = 'icon';
    favicon.href = uiAssets.appIcon;
    document.head.appendChild(favicon);
  }, []);

  useEffect(() => {
    void loadMaps();
  }, []);

  // Deletes still waiting for their undo window go through when the page closes.
  useEffect(() => {
    const flush = () => {
      const pending = pendingDeleteRef.current;
      if (!pending) return;
      pendingDeleteRef.current = null;
      window.clearTimeout(pending.timer);
      void mapStore.deleteMany(pending.ids).catch(() => undefined);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  useEffect(() => {
    if (!pendingDelete || screen.kind !== 'library') return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undoDelete();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingDelete, screen.kind]);

  useEffect(() => {
    window.__mapEditorConfirmLeave = async () => {
      if (!leaveGuardRef.current) return true;
      return leaveGuardRef.current();
    };
    return () => {
      delete window.__mapEditorConfirmLeave;
    };
  }, []);

  async function loadMaps() {
    setLoading(true);
    setError('');
    try {
      const nextMaps = await mapStore.list();
      startTransition(() => setMaps(nextMaps));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load War of Dots maps.');
    } finally {
      setLoading(false);
    }
  }

  function openImported(map: StoredMap) {
    setMaps((current) => upsertMap(current, map));
    setScreen({ kind: 'editor', mapId: map.id });
  }

  async function handleImportReplay(name: string, source: ReplaySource) {
    setImportBusy(true);
    setImportError('');
    try {
      const imported = await mapStore.importReplay(name, source);
      if ('shared' in source) {
        // A map code stays in the dialog, marked as imported, so more codes can follow.
        const { code } = source.shared;
        setMaps((current) => upsertMap(current, imported));
        setImportedCodes((current) => new Set(current).add(code));
        return;
      }
      setImportOpen(false);
      openImported(imported);
    } catch (nextError) {
      setImportError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setImportBusy(false);
    }
  }

  /** Files from the import dialog, added to the game: map files (.txt) as they are, and a replay's map. */
  async function handleImportFiles(files: File[]) {
    setImportBusy(true);
    setImportError('');
    const failures: string[] = [];
    let last: StoredMap | null = null;
    for (const file of files) {
      try {
        last = /\.(rep|json)$/i.test(file.name)
          ? await mapStore.importReplay(file.name.replace(/\.(rep|json)$/i, ''), { file })
          : await mapStore.importFile(file);
        const added = last;
        setMaps((current) => upsertMap(current, added));
      } catch (nextError) {
        failures.push(`${file.name}: ${nextError instanceof Error ? nextError.message : String(nextError)}`);
      }
    }
    setImportBusy(false);
    if (failures.length) {
      setImportError(failures.join(' '));
      return;
    }
    setImportOpen(false);
    if (files.length === 1 && last) openImported(last);
  }

  /** A copy of a map, saved to the game and added to the library. */
  async function handleDuplicateMap(map: StoredMap) {
    setError('');
    try {
      const copy = await mapStore.duplicate(map.id);
      setMaps((current) => upsertMap(current, copy));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  /** Renames a map from its card; errors go back to the card. */
  async function handleRenameMap(map: StoredMap, name: string) {
    const renamed = await mapStore.rename(map.id, name);
    setMaps((current) => upsertMap(current.filter((entry) => entry.id !== map.id), renamed));
  }

  async function handleCreateMap(name: string, teams: number, large: boolean) {
    setImportOpen(false);
    try {
      const created = await mapStore.create(name, teams, large);
      setNewMap(created);
      setScreen({ kind: 'editor', mapId: created.id });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to create a map.');
    }
  }

  /** Hides the maps at once and removes their files once the undo window ends. */
  function requestDelete(ids: string[], label: string) {
    if (!ids.length) return;
    commitPendingDelete();
    const timer = window.setTimeout(commitPendingDelete, UNDO_DELETE_MS);
    const pending = { ids, label, timer };
    pendingDeleteRef.current = pending;
    setPendingDelete(pending);
  }

  function commitPendingDelete() {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    pendingDeleteRef.current = null;
    window.clearTimeout(pending.timer);
    setPendingDelete(null);
    void handleDeleteMaps(pending.ids);
  }

  function undoDelete() {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    pendingDeleteRef.current = null;
    window.clearTimeout(pending.timer);
    setPendingDelete(null);
  }

  async function handleDeleteMaps(fileNames: string[]) {
    if (!fileNames.length) return;
    setError('');
    try {
      const deleted = await mapStore.deleteMany(fileNames);
      const deletedSet = new Set(deleted);
      setMaps((current) => current.filter((map) => !deletedSet.has(map.id)));
      await loadMaps();
    } catch (nextError) {
      await loadMaps();
      setError(String(nextError));
    }
  }

  const activeMap = screen.kind === 'editor' ? maps.find((map) => map.id === screen.mapId) ?? (newMap?.id === screen.mapId ? newMap : undefined) : undefined;
  if (activeMap) setCanvasSize(activeMap.width, activeMap.height);

  return (
    <div className="map-editor-scope" data-screen={screen.kind}>
      <div className="app-shell">
        <main className="app-main">
          {screen.kind === 'library' && (
            <>
              {error ? <div className="dialog-error map-editor-error">{error}</div> : null}
              <MapLibrary
                loading={loading}
                maps={shownMaps}
                onAdd={() => { setImportError(''); setImportOpen(true); }}
                onDeleteSelected={requestDelete}
                onEdit={(mapId) => setScreen({ kind: 'editor', mapId })}
                onRename={handleRenameMap}
                onDuplicate={(map) => void handleDuplicateMap(map)}
              />
            </>
          )}

          {screen.kind === 'editor' && activeMap && (
            <EditorScreen
              initialMap={activeMap}
              onClose={(savedMap) => {
                // A new map that was never saved has no file and is not listed.
                if (savedMap && savedMap.status !== 'unsaved') setMaps((current) => upsertMap(current, savedMap));
                setNewMap(null);
                setScreen({ kind: 'library' });
                void loadMaps();
              }}
              registerLeaveGuard={(handler) => {
                leaveGuardRef.current = handler;
              }}
            />
          )}
        </main>

        {pendingDelete ? createPortal(
          <div className="map-delete-toast" role="status" aria-live="polite" key={pendingDelete.timer}>
            <span className="map-delete-toast-copy">Deleted <strong>{pendingDelete.label}</strong></span>
            <button type="button" onClick={undoDelete}>Undo</button>
            <span className="map-delete-toast-timer" aria-hidden="true" style={{ animationDuration: `${UNDO_DELETE_MS}ms` }} />
          </div>,
          portalHost(),
        ) : null}

        {createPortal(
          <ReplayImportDialog
            open={importOpen}
            busy={importBusy}
            error={importError}
            onCancel={() => setImportOpen(false)}
            onCreate={(name, teams, large) => void handleCreateMap(name, teams, large)}
            onImport={(name, source) => void handleImportReplay(name, source)}
            onImportFiles={(files) => void handleImportFiles(files)}
            importedCodes={importedCodes}
            librarySurfaces={librarySurfaces}
          />,
          portalHost(),
        )}
      </div>
    </div>
  );
}
