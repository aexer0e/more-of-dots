// The map editor's Import dialog. Its first tab makes a new, empty map; the
// others make a map from the map a replay was
// played on (one of the replays in the library, shown as cards with the map's
// layout, or a .rep file), from map files (.txt), or from a map shared in the
// game's map hub, by its code. It uses the add-replays dialog's styles.
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../platform';
import { drawMapPreview, type MapPreview } from '../lib/mapPreview';
import { normalizeMapData } from '../lib/mapCodec';
import { TEAM_COUNTS } from '../lib/constants';
import { fetchSharedMap, type MapSource, type SharedMap } from '../lib/storage';

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

/** The width and height in a PNG's header, read from its base64. */
function pngSize(base64: string): [number, number] {
  const bytes = Uint8Array.from(atob(base64.slice(0, 32)), (char) => char.charCodeAt(0));
  if (bytes.length < 24) return [960, 540];
  const view = new DataView(bytes.buffer);
  return [view.getUint32(16), view.getUint32(20)];
}

const THUMB_UP = (
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 11v9H4.5A1.5 1.5 0 0 1 3 18.5v-6A1.5 1.5 0 0 1 4.5 11z" /><path d="M7 11l4-7.5a2 2 0 0 1 3.7 1.4L14 9h5.1a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.8 20H7" /></svg>
);
const THUMB_DOWN = (
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M17 13V4h2.5A1.5 1.5 0 0 1 21 5.5v6a1.5 1.5 0 0 1-1.5 1.5z" /><path d="M17 13l-4 7.5a2 2 0 0 1-3.7-1.4L10 15H4.9a2 2 0 0 1-2-2.4l1.4-7A2 2 0 0 1 6.2 4H17" /></svg>
);

function SharedMapCard({ shared, busy, imported, onPick }: { shared: SharedMap; busy: boolean; imported: boolean; onPick: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'waiting' | 'ready' | 'failed'>('waiting');
  const data = useMemo(() => normalizeMapData(shared.map), [shared]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let cancelled = false;
    setState('waiting');
    const [width, height] = pngSize(shared.map.map_surface);
    drawMapPreview(element, { data, width, height, mode: shared.map.mode }, base)
      .then(() => { if (!cancelled) setState('ready'); })
      .catch(() => { if (!cancelled) setState('failed'); });
    return () => { cancelled = true; };
  }, [shared, data]);

  const title = shared.title || `Map ${shared.code}`;
  const date = shared.date ? new Date(shared.date * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return (
    <article className="map-code-card" aria-label={title}>
      <div className="map-import-thumb map-code-thumb" data-state={state}>
        <canvas ref={canvas} width={640} height={360} aria-hidden="true" />
        {state === 'waiting' ? <span className="map-import-thumb-note">Loading the map</span> : null}
        {state === 'failed' ? <span className="map-import-thumb-note">No preview</span> : null}
      </div>
      <div className="map-code-body">
        <div className="map-code-heading">
          <h3>{title}</h3>
          <p>{shared.author ? `By ${shared.author}` : 'Unknown author'}</p>
        </div>
        <dl className="map-code-facts">
          <dt>Code</dt><dd>{shared.code}</dd>
          {shared.map.mode ? <><dt>Mode</dt><dd>{shared.map.mode}</dd></> : null}
          {date ? <><dt>Shared</dt><dd>{date}</dd></> : null}
        </dl>
        <div className="map-code-actions">
          {/* Votes from the game's map hub; voting happens in the game. */}
          <div className="map-code-votes" title="Votes in the game's map hub">
            <span className="map-code-vote" aria-label={`${shared.upvotes} upvotes`}>{THUMB_UP}{shared.upvotes}</span>
            <span className="map-code-vote" aria-label={`${shared.downvotes} downvotes`}>{THUMB_DOWN}{shared.downvotes}</span>
          </div>
          {imported ? (
            <span className="map-code-imported" title="This map is already in your library">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
              Imported
            </span>
          ) : (
            <button className="add-replays-choose map-code-import" type="button" disabled={busy} onClick={onPick}>
              {busy ? 'Importing...' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

/** The map code card before a map is shown: the same layout, with the message
 * in the preview's place, so the dialog keeps one size. */
function PlaceholderCard({ state, message }: { state: 'empty' | 'loading' | 'failed'; message: string }) {
  return (
    <div className={`map-code-card is-placeholder is-${state}`}>
      <div className="map-import-thumb map-code-thumb">
        <span className="map-import-thumb-note" role={state === 'failed' ? 'alert' : undefined}>{message}</span>
      </div>
      <div className="map-code-body" aria-hidden="true">
        <div className="map-code-heading">
          <span className="map-code-skeleton" style={{ width: '72%', height: 18 }} />
          <span className="map-code-skeleton" style={{ width: '42%' }} />
        </div>
        <div className="map-code-heading">
          <span className="map-code-skeleton" style={{ width: '48%' }} />
          <span className="map-code-skeleton" style={{ width: '38%' }} />
          <span className="map-code-skeleton" style={{ width: '56%' }} />
        </div>
        <div className="map-code-actions">
          <span className="map-code-skeleton" style={{ width: 72 }} />
          <button className="add-replays-choose map-code-import" type="button" disabled tabIndex={-1}>Import</button>
        </div>
      </div>
    </div>
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

export type ReplaySource = MapSource;

// The two terrain sizes the game's maps use, and the battlefield each plays on.
const MAP_SIZES = [
  { large: false, label: '960 × 540', detail: '1600 × 900 battlefield' },
  { large: true, label: '1920 × 1080', detail: '1920 × 1080 battlefield' },
];

function NewMapPanel({ onCreate }: { onCreate: (name: string, teams: number, large: boolean) => void }) {
  const [name, setName] = useState('Untitled map');
  const [teams, setTeams] = useState(2);
  const [large, setLarge] = useState(false);
  const create = () => onCreate(name.trim() || 'Untitled map', teams, large);
  return (
    <form className="map-new" role="tabpanel" onSubmit={(event) => { event.preventDefault(); create(); }}>
      <label className="map-new-field">
        <span>Name</span>
        <span className="add-replays-link-field">
          <input autoFocus type="text" maxLength={64} value={name} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setName(event.target.value)} />
        </span>
      </label>
      <div className="map-new-field">
        <span id="mapNewTeams">Teams</span>
        <div className="map-new-choice" role="radiogroup" aria-labelledby="mapNewTeams">
          {TEAM_COUNTS.map((count) => (
            <button key={count} type="button" role="radio" aria-checked={teams === count} onClick={() => setTeams(count)}>{count} teams</button>
          ))}
        </div>
      </div>
      <div className="map-new-field">
        <span id="mapNewSize">Size</span>
        <div className="map-new-choice" role="radiogroup" aria-labelledby="mapNewSize">
          {MAP_SIZES.map((size) => (
            <button key={size.label} type="button" role="radio" aria-checked={large === size.large} onClick={() => setLarge(size.large)}>
              {size.label}<small>{size.detail}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="map-new-actions">
        <button className="add-replays-choose" type="submit">Create map</button>
      </div>
    </form>
  );
}

interface ReplayImportDialogProps {
  open: boolean;
  busy: boolean;
  error: string;
  onCancel: () => void;
  /** Makes a new, empty map from the first tab. */
  onCreate: (name: string, teams: number, large: boolean) => void;
  onImport: (name: string, source: ReplaySource) => void;
  /** Replays (.rep) and map files (.txt) chosen or dropped on the file tab. */
  onImportFiles: (files: File[]) => void;
  /** Map codes imported while the dialog is open; they stay listed so more can be added. */
  importedCodes: ReadonlySet<string>;
  /** The terrain of each map in the library; a map hub map with one of them is already imported. */
  librarySurfaces: ReadonlySet<string>;
}

const IMPORT_FILE = /\.(rep|json|txt)$/i;

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

export function ReplayImportDialog({ open, busy, error, onCancel, onCreate, onImport, onImportFiles, importedCodes, librarySurfaces }: ReplayImportDialogProps) {
  const [tab, setTab] = useState<'new' | 'library' | 'file' | 'code'>('new');
  const [code, setCode] = useState('');
  const [lookup, setLookup] = useState<
    | { code: string; state: 'loading' }
    | { code: string; state: 'found'; map: SharedMap }
    | { code: string; state: 'failed'; error: string }
    | null
  >(null);
  const [replays, setReplays] = useState<ReplayListItem[] | null>(null);
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  // Each time the dialog opens it starts on New map.
  useEffect(() => {
    if (open) setTab('new');
  }, [open]);

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

  async function findCode() {
    const wanted = code.trim();
    if (!wanted) return;
    setLookup({ code: wanted, state: 'loading' });
    try {
      const map = await fetchSharedMap(wanted);
      setLookup((current) => (current?.code === wanted ? { code: wanted, state: 'found', map } : current));
    } catch (nextError) {
      const error = nextError instanceof Error ? nextError.message : String(nextError);
      setLookup((current) => (current?.code === wanted ? { code: wanted, state: 'failed', error } : current));
    }
  }

  if (!open) return null;

  return (
    <div className="add-replays-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="add-replays-dialog map-import-dialog" role="dialog" aria-modal="true" aria-labelledby="mapImportTitle">
        <header className="add-replays-header">
          <h2 id="mapImportTitle">Add a map</h2>
          <button className="recording-setup-close" type="button" aria-label="Close" disabled={busy} onClick={onCancel}>{CLOSE_ICON}</button>
        </header>
        <div className="map-import-tabs" role="tablist" aria-label="Map source">
          <button role="tab" type="button" aria-selected={tab === 'new'} onClick={() => setTab('new')}>New map</button>
          <button role="tab" type="button" aria-selected={tab === 'library'} onClick={() => setTab('library')}>Your replays</button>
          <button role="tab" type="button" aria-selected={tab === 'file'} onClick={() => setTab('file')}>From file</button>
          <button role="tab" type="button" aria-selected={tab === 'code'} onClick={() => setTab('code')}>Map code</button>
        </div>

        {tab === 'new' ? (
          <NewMapPanel onCreate={onCreate} />
        ) : tab === 'library' ? (
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
        ) : tab === 'code' ? (
          <div className="map-import-library" role="tabpanel">
            <form className="map-import-code" onSubmit={(event) => { event.preventDefault(); void findCode(); }}>
              <label className="add-replays-link-field">
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" /></svg>
                <span className="add-replays-sr">Map code</span>
                <input autoFocus type="text" inputMode="numeric" autoComplete="off" maxLength={10} placeholder="Map code, such as 1234" value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
              </label>
              <button className="add-replays-choose" type="submit" disabled={!code || lookup?.state === 'loading'}>Find map</button>
            </form>
            {/* One box of the card's size for every state, so a search never resizes the dialog. */}
            <div className="map-code-result" aria-live="polite">
              {lookup?.state === 'found' ? (
                <SharedMapCard shared={lookup.map} busy={busy} imported={importedCodes.has(lookup.map.code) || librarySurfaces.has(lookup.map.map.map_surface)} onPick={() => onImport(lookup.map.title || `Map ${lookup.map.code}`, { shared: lookup.map })} />
              ) : (
                <PlaceholderCard
                  state={lookup?.state === 'loading' ? 'loading' : lookup?.state === 'failed' ? 'failed' : 'empty'}
                  message={lookup?.state === 'loading' ? `Looking up map ${lookup.code}` : lookup?.state === 'failed' ? lookup.error : 'Enter a map code to see the map here'}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="add-replays-dropzone" role="tabpanel"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const files = [...event.dataTransfer.files].filter((candidate) => IMPORT_FILE.test(candidate.name));
              if (files.length && !busy) onImportFiles(files);
            }}>
            {FILE_ICON}
            <strong>Drop .rep or .txt files here</strong>
            <small>A replay gives the map it was played on; a map file (.txt) is added as it is.</small>
            <button className="add-replays-choose" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>Choose files</button>
            <input ref={fileInput} type="file" accept=".rep,.json,.txt" multiple hidden onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              if (files.length) onImportFiles(files);
            }} />
          </div>
        )}

        {/* The map code card's button shows its own progress, so the dialog keeps its size. */}
        {busy && tab !== 'code' && tab !== 'new' ? <p className="map-import-empty" aria-live="polite">Importing the map...</p> : null}
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
