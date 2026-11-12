import { exampleMode, invoke } from '../../platform';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import { mountEditor, type EditorHandle } from '../editor/screen.js';
import { mapSurfaceFromImageFile } from '../lib/mapCodec';
import { mapStore } from '../lib/storage';
import type { StoredMap } from '../lib/types';

interface EditorScreenProps {
  initialMap: StoredMap;
  onClose: (map?: StoredMap) => void;
  registerLeaveGuard?: (handler: (() => Promise<boolean>) | null) => void;
}

async function imageFromBase64(base64: string) {
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('The image could not be read.'));
  });
  return image;
}

/**
 * The map editor (src/map-editor/editor). It edits the map in the game's own
 * coordinates and saves it as a draft, or to the game. Leaving with unsaved
 * changes asks whether to save them as a draft or discard them.
 */
export function EditorScreen({ initialMap, onClose, registerLeaveGuard }: EditorScreenProps) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let handle: EditorHandle | null = null;
    let cancelled = false;
    let id = initialMap.id;
    let latest: StoredMap | undefined;
    let unlisten: (() => void) | null = null;
    const desktop = isTauri() && !exampleMode;
    // Closing the window with unsaved changes asks first (src-tauri: UnsavedMap).
    const reportUnsaved = (unsaved: boolean) => {
      if (desktop) void invoke('map_editor_unsaved', { unsaved }).catch(() => {});
    };
    if (desktop)
      void listen('map-editor-close-requested', async () => {
        if (!handle || (await handle.confirmLeave())) await invoke('quit_app');
      }).then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      });
    void (async () => {
      const map = await mapStore.getGame(id);
      if (cancelled || !host.current) return;
      handle = mountEditor(host.current, {
        map: { ...map.data, width: map.width, height: map.height, surface: `data:image/png;base64,${map.data.map_surface}` },
        name: map.name || map.fileName,
        status: map.status,
        base: import.meta.env.BASE_URL,
        saveLabel: exampleMode ? 'Save example' : 'Save to game',
        async onSave(data, publish) {
          const saved = await mapStore.putGame(id, { ...map.data, ...data }, publish);
          // Saving a map from the game folder makes a draft with its own id.
          id = saved.id;
          latest = saved;
          return saved.status ?? 'draft';
        },
        onClose: () => onClose(latest),
        onTerrainImage: async (file, width, height) => imageFromBase64(await mapSurfaceFromImageFile(file, width, height)),
        onDirty: reportUnsaved,
        async onRename(name) {
          // Renaming a map in the game folder renames its file, so its id can change.
          const renamed = await mapStore.rename(id, name);
          id = renamed.id;
          latest = renamed;
          return renamed.name;
        },
      });
      registerLeaveGuard?.(async () => (handle ? handle.confirmLeave() : true));
    })().catch((nextError) => {
      if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
    });
    return () => {
      cancelled = true;
      registerLeaveGuard?.(null);
      unlisten?.();
      reportUnsaved(false);
      handle?.destroy();
    };
    // The editor keeps its own state; it opens once per map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMap.id]);

  return (
    <div style={{ height: '100%', padding: 8, boxSizing: 'border-box' }}>
      {error ? (
        <div className="dialog-error" role="alert">
          {error} <button className="secondary-button compact" type="button" onClick={() => onClose()}>Back to the library</button>
        </div>
      ) : null}
      <div ref={host} style={{ height: '100%' }} />
    </div>
  );
}
