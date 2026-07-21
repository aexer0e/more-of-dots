import { startTransition, useEffect, useRef, useState } from 'react';
import { EditorScreen } from './components/EditorScreen';
import { MapLibrary } from './components/MapLibrary';
import { uiAssets } from './lib/assets';
import { setCanvasSize } from './lib/constants';
import { mapStore } from './lib/storage';
import type { StoredMap } from './lib/types';
import './styles.css';

declare global {
  interface Window {
    __mapEditorConfirmLeave?: () => Promise<boolean>;
  }
}

type Screen =
  | { kind: 'library' }
  | { kind: 'editor'; mapId: string };

function upsertMap(collection: StoredMap[], nextMap: StoredMap) {
  return [nextMap, ...collection.filter((map) => map.id !== nextMap.id)].sort((left, right) => right.updatedAt - left.updatedAt);
}

interface PromptDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

function PromptDialog({ open, onCancel, onConfirm }: PromptDialogProps) {
  const [value, setValue] = useState('Untitled map');

  useEffect(() => {
    if (open) setValue('Untitled map');
  }, [open]);

  if (!open) return null;

  return (
    <div className="dialog-scrim" role="presentation">
      <div aria-modal="true" className="dialog-card" role="dialog">
        <p className="eyebrow">Map details</p>
        <h3>Create a new map</h3>
        <p>The file will be written directly into War of Dots&apos; map_editor folder.</p>
        <input
          autoFocus
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onConfirm(value.trim());
            if (event.key === 'Escape') onCancel();
          }}
        />
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary-button" type="button" onClick={() => onConfirm(value.trim())}>
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

  async function handleCreateMap(name: string) {
    setCreateOpen(false);
    if (!name) return;
    try {
      const created = await mapStore.create(name);
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
      setMaps((current) => current.filter((map) => !deletedSet.has(map.fileName || map.id)));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to delete selected maps.');
      await loadMaps();
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
                onDeleteSelected={(fileNames) => void handleDeleteMaps(fileNames)}
                onEdit={(mapId) => setScreen({ kind: 'editor', mapId })}
                onRefresh={() => void loadMaps()}
              />
            </>
          )}

          {screen.kind === 'editor' && activeMap && (
            <EditorScreen
              initialMap={activeMap}
              saveMap={mapStore.put}
              onClose={(savedMap) => {
                if (savedMap) setMaps((current) => upsertMap(current, savedMap));
                setScreen({ kind: 'library' });
              }}
              registerLeaveGuard={(handler) => {
                leaveGuardRef.current = handler;
              }}
            />
          )}
        </main>

        <PromptDialog open={createOpen} onCancel={() => setCreateOpen(false)} onConfirm={(value) => void handleCreateMap(value)} />
      </div>
    </div>
  );
}
