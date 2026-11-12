// Makes a map from the map a replay was played on: one of the replays in the
// library, shown as cards with the map's layout, or a .rep file chosen here. It
// uses the add-replays dialog's styles.
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../platform';
import { drawMapPreview, type MapPreview } from '../lib/mapPreview';
import { normalizeMapData } from '../lib/mapCodec';

const base = import.meta.env.BASE_URL;

// Each replay's map is read once, a few at a time, as its card comes into view.
const previews = new Map<string, Promise<MapPreview>>();
let reading = 0;
const waiting: Array<() => void> = [];
async function readPreview(filePath: string) {
  if (!previews.has(filePath)) {
    previews.set(filePath, (async () => {
      if (reading >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
      reading++;
      try {
        const preview = await invoke<MapPreview>('replay_map_preview', { filePath });
        return { ...preview, data: normalizeMapData(preview.data) };
      } finally {
        reading--;
        waiting.shift()?.();
      }
    })());
    previews.get(filePath)!.catch(() => previews.delete(filePath));
  }
  return previews.get(filePath)!;
}

function ReplayCard({ replay, count, busy, onPick }: { replay: ReplayListItem; count: number; busy: boolean; onPick: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'waiting' | 'ready' | 'failed'>('waiting');
  const [teams, setTeams] = useState(0);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let cancelled = false;
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      readPreview(replay.filePath)
        .then(async (preview) => {
          if (cancelled) return;
          await drawMapPreview(element, preview, base);
          if (!cancelled) { setTeams(preview.data.infantry.length); setState('ready'); }
        })
        .catch(() => { if (!cancelled) setState('failed'); });
    }, { rootMargin: '200px' });
    seen.observe(element);
    return () => { cancelled = true; seen.disconnect(); };
  }, [replay.filePath]);

  return (
    <li>
      <button type="button" className="map-import-card" disabled={busy || state === 'failed'} onClick={onPick} title={state === 'failed' ? 'This replay does not record a map that can be opened.' : `Make a map from ${replayTitle(replay)}`}>
        <span className="map-import-thumb" data-state={state}>
          <canvas ref={canvas} width={320} height={180} />
          {state === 'waiting' ? <span className="map-import-thumb-note">Loading the map</span> : null}
          {state === 'failed' ? <span className="map-import-thumb-note">No map to open</span> : null}
          {teams ? <span className="map-import-teams">{teams} teams</span> : null}
          {count > 1 ? <span className="map-import-count" title={`${count} of your replays were played on this map; the newest is shown`}>{count} replays</span> : null}
        </span>
        <span className="map-import-title">{replayTitle(replay)}</span>
        <span className="map-import-detail">{replayPlayers(replay)}</span>
        <span className="map-import-meta">{[replay.mode, replay.length, new Date(replay.modified * (replay.modified < 1e12 ? 1000 : 1)).toLocaleDateString()].filter(Boolean).join(' \u00b7 ')}</span>
      </button>
    </li>
  );
}

interface ReplayListItem {
  fileName: string;
  filePath: string;
  mode?: string | null;
  players: Array<{ name: string; teamIndex: number }>;
  length: string;
  modified: number;
  mapLabel?: string | null;
  /** The map's identity: an official map's image, or a hash of a custom map's terrain. */
  mapKey?: string | null;
}

export type ReplaySource = { filePath: string } | { file: File };

interface ReplayImportDialogProps {
  open: boolean;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onImport: (name: string, source: ReplaySource) => void;
}

const CLOSE_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
);
const FILE_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M12 17v-6" /><path d="M9.5 13.5 12 11l2.5 2.5" /></svg>
);

function replayTitle(replay: ReplayListItem) {
  return replay.mapLabel || replay.fileName.replace(/\.rep$/i, '');
}

function replayPlayers(replay: ReplayListItem) {
  return replay.players.map((player) => player.name).filter(Boolean).join(' vs ') || 'Unknown players';
}

function fileStem(name: string) {
  return name.replace(/\.(rep|json)$/i, '');
}

export function ReplayImportDialog({ open, busy, error, onCancel, onImport }: ReplayImportDialogProps) {
  const [tab, setTab] = useState<'library' | 'file'>('library');
  const [replays, setReplays] = useState<ReplayListItem[] | null>(null);
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || replays) return;
    invoke<{ replays: ReplayListItem[] }>('list_replays', { offset: 0, limit: 0 })
      .then((payload) => setReplays([...payload.replays].sort((a, b) => b.modified - a.modified)))
      .catch((nextError) => setListError(String(nextError instanceof Error ? nextError.message : nextError)));
  }, [open, replays]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  // One card for each map: the newest replay played on it, with how many there are.
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (replays ?? []).filter((replay) => {
      if (!words.length) return true;
      const text = `${replayTitle(replay)} ${replayPlayers(replay)} ${replay.mode ?? ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
    const maps = new Map<string, { replay: ReplayListItem; count: number }>();
    for (const replay of matches) {
      const key = replay.mapKey || replay.filePath;
      const seen = maps.get(key);
      if (seen) seen.count++;
      else maps.set(key, { replay, count: 1 });
    }
    return [...maps.values()].slice(0, 120);
  }, [replays, query]);

  if (!open) return null;

  return (
    <div className="add-replays-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="add-replays-dialog map-import-dialog" role="dialog" aria-modal="true" aria-labelledby="mapImportTitle">
        <header className="add-replays-header">
          <h2 id="mapImportTitle">Import from .rep</h2>
          <button className="recording-setup-close" type="button" aria-label="Close" disabled={busy} onClick={onCancel}>{CLOSE_ICON}</button>
        </header>
        <p className="map-import-note">Makes a draft from the map a replay was played on: its terrain, starting units, cities, capitals and bridges.</p>
        <div className="map-import-tabs" role="tablist" aria-label="Replay source">
          <button role="tab" type="button" aria-selected={tab === 'library'} onClick={() => setTab('library')}>Your replays</button>
          <button role="tab" type="button" aria-selected={tab === 'file'} onClick={() => setTab('file')}>Upload file</button>
        </div>

        {tab === 'library' ? (
          <div className="map-import-library" role="tabpanel">
            <label className="add-replays-link-field">
              <span className="add-replays-sr">Search replays</span>
              <input autoFocus type="search" placeholder="Search by map or player" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            {listError ? <p className="dialog-error">{listError}</p> : null}
            {!replays && !listError ? <p className="map-import-empty">Loading replays...</p> : null}
            {replays && !shown.length ? <p className="map-import-empty">{replays.length ? 'No replays match.' : 'No replays in your library yet.'}</p> : null}
            {shown.length ? (
              <ul className="map-import-grid">
                {shown.map(({ replay, count }) => (
                  <ReplayCard key={replay.filePath} replay={replay} count={count} busy={busy} onPick={() => onImport(replayTitle(replay), { filePath: replay.filePath })} />
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="add-replays-dropzone" role="tabpanel"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = [...event.dataTransfer.files].find((candidate) => /\.(rep|json)$/i.test(candidate.name));
              if (file && !busy) onImport(fileStem(file.name), { file });
            }}>
            {FILE_ICON}
            <strong>Drop a .rep file here</strong>
            <button className="add-replays-choose" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>Choose file</button>
            <input ref={fileInput} type="file" accept=".rep,.json" hidden onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onImport(fileStem(file.name), { file });
            }} />
          </div>
        )}

        {busy ? <p className="map-import-empty" aria-live="polite">Importing the map...</p> : null}
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
