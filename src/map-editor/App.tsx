import { startTransition, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorScreen } from './components/EditorScreen';
import { MapLibrary } from './components/MapLibrary';
import { ReplayImportDialog, type ReplaySource } from './components/ReplayImportDialog';
import { uiAssets } from './lib/assets';
import { TEAM_COUNTS, setCanvasSize } from './lib/constants';
import { mapStore } from './lib/storage';
import type { StoredMap } from './lib/types';
import './styles.css';
import './library.css';

declare global {
  interface Window {
    __mapEditorConfirmLeave?: () => Promise<boolean>;
  }
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

interface PromptDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (value: string, teams: number, large: boolean) => void;
}

// The two terrain sizes the game's maps use, and the battlefield each plays on.
const MAP_SIZES = [
  { large: false, label: '960 \u00d7 540', detail: '1600 \u00d7 900 battlefield' },
  { large: true, label: '1920 \u00d7 1080', detail: '1920 \u00d7 1080 battlefield' },
];

function PromptDialog({ open, onCancel, onConfirm }: PromptDialogProps) {
  const [value, setValue] = useState('Untitled map');
  const [teams, setTeams] = useState(2);
  const [large, setLarge] = useState(false);

  useEffect(() => {
    if (open) {
      setValue('Untitled map');
      setTeams(2);
      setLarge(false);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="dialog-scrim" role="presentation">
      <div aria-modal="true" className="dialog-card" role="dialog">
        <p className="eyebrow">Map details</p>
        <h3>Create a new map</h3>
        <p>New maps are saved as drafts in More of Dots. Use Save to game when your map is ready to play.</p>
        <input
          autoFocus
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onConfirm(value.trim(), teams, large);
            if (event.key === 'Escape') onCancel();
          }}
        />
        <div className="team-count-choice" role="radiogroup" aria-label="Teams">
          {TEAM_COUNTS.map((count) => (
            <button key={count} type="button" role="radio" aria-checked={teams === count} onClick={() => setTeams(count)}>
              {count} teams
            </button>
          ))}
        </div>
        <div className="team-count-choice map-size-choice" role="radiogroup" aria-label="Map size">
          {MAP_SIZES.map((size) => (
            <button key={size.label} type="button" role="radio" aria-checked={large === size.large} title={`Terrain ${size.label}, played on a ${size.detail}`} onClick={() => setLarge(size.large)}>
              <span>{size.label}</span>
              <small>{size.detail}</small>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary-button" type="button" onClick={() => onConfirm(value.trim(), teams, large)}>
            Create map
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MapEditorApp() {
  const [maps, setMaps] = useState<StoredMap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [screen, setScreen] = useState<Screen>({ kind: 'library' });
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const uploadInput = useRef<HTMLInputElement>(null);
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
      setImportOpen(false);
      openImported(imported);
    } catch (nextError) {
      setImportError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setImportBusy(false);
    }
  }

  /** Map files become drafts; a replay chosen here gives its map. */
  async function handleUpload(files: File[]) {
    setError('');
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
    if (failures.length) setError(failures.join(' '));
    else if (files.length === 1 && last) openImported(last);
  }

  /** Renames a map from its card; errors go back to the card. */
  async function handleRenameMap(map: StoredMap, name: string) {
    const renamed = await mapStore.rename(map.id, name);
    setMaps((current) => upsertMap(current.filter((entry) => entry.id !== map.id), renamed));
    // A draft that edits a renamed game map follows it, so the list is read again.
    void loadMaps();
  }

  async function handleCreateMap(name: string, teams: number, large: boolean) {
    setCreateOpen(false);
    if (!name) return;
    try {
      const created = await mapStore.create(name, teams, large);
      setMaps((current) => upsertMap(current, created));
      setScreen({ kind: 'editor', mapId: created.id });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to create a map.');
    }
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

  const activeMap = screen.kind === 'editor' ? maps.find((map) => map.id === screen.mapId) : undefined;
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
                maps={maps}
                onCreate={() => setCreateOpen(true)}
                onRefresh={() => void loadMaps()}
                onDeleteSelected={(fileNames) => void handleDeleteMaps(fileNames)}
                onEdit={(mapId) => setScreen({ kind: 'editor', mapId })}
                onRename={handleRenameMap}
              />
              {/* The same place and look as Upload on the Replays page, so it stays put between
                  tabs. It is drawn outside the editor's scoped styles for that reason. */}
              {createPortal(<div className="replay-upload-dock">
                <div className="replay-action-group" role="group" aria-label="Add maps">
                  <button className="refresh-button upload-button" type="button" title="Add map files (.txt) as drafts" onClick={() => uploadInput.current?.click()}>
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M12 16V4" />
                      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
                      <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
                    </svg>
                    <span>Upload</span>
                  </button>
                  <button className="refresh-button" type="button" aria-haspopup="dialog" title="Make a map from a replay" onClick={() => { setImportError(''); setImportOpen(true); }}>
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M4 5h16v11H4z" />
                      <path d="m10 8.5 4 2.5-4 2.5z" />
                      <path d="M8 20h8" />
                    </svg>
                    <span>Import from .rep</span>
                  </button>
                  <input ref={uploadInput} type="file" accept=".txt,.rep" multiple hidden onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    if (files.length) void handleUpload(files);
                  }} />
                </div>
              </div>, portalHost())}
            </>
          )}

          {screen.kind === 'editor' && activeMap && (
            <EditorScreen
              initialMap={activeMap}
              onClose={(savedMap) => {
                if (savedMap) setMaps((current) => upsertMap(current, savedMap));
                setScreen({ kind: 'library' });
                void loadMaps();
              }}
              registerLeaveGuard={(handler) => {
                leaveGuardRef.current = handler;
              }}
            />
          )}
        </main>

        <PromptDialog open={createOpen} onCancel={() => setCreateOpen(false)} onConfirm={(value, teams, large) => void handleCreateMap(value, teams, large)} />
        {createPortal(
          <ReplayImportDialog
            open={importOpen}
            busy={importBusy}
            error={importError}
            onCancel={() => setImportOpen(false)}
            onImport={(name, source) => void handleImportReplay(name, source)}
          />,
          portalHost(),
        )}
      </div>
    </div>
  );
}
