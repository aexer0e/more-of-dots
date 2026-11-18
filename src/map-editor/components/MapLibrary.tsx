import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CANVAS_HEIGHT, CANVAS_WIDTH, CAPITAL_SIZE, CITY_SIZE, SPRITE_SIZE, TEAM_COUNTS, teamColorForIndex } from '../lib/constants';
import type { StoredMap } from '../lib/types';
import { spriteAssets, uiAssets } from '../lib/assets';

interface MapLibraryProps {
  maps: StoredMap[];
  loading: boolean;
  /** Opens the dialog that makes a new map or imports one. */
  onAdd: () => void;
  onDeleteSelected: (fileNames: string[], label: string) => void;
  onEdit: (mapId: string) => void;
  /** Renames a map; rejects with a message when the name cannot be used. */
  onRename: (map: StoredMap, name: string) => Promise<void>;
  /** Copies a map in the game. */
  onDuplicate: (map: StoredMap) => void;
}

/** A map's name; clicking it, or Rename in the card's menu (`editRequest`
 * changes), edits the name in place. Enter or leaving the field saves it,
 * Escape keeps the old one. */
function MapName({ map, disabled, editRequest, onRename }: { map: StoredMap; disabled: boolean; editRequest: number; onRename: MapLibraryProps['onRename'] }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Enter disables the field, which also blurs it; one rename is sent.
  const sending = useRef(false);
  // Only a new request opens the field, not one made before this card mounted.
  const seenRequest = useRef(editRequest);
  useEffect(() => {
    if (editRequest === seenRequest.current) return;
    seenRequest.current = editRequest;
    setError('');
    setEditing(true);
  }, [editRequest]);

  async function commit(value: string) {
    if (sending.current) return;
    const name = value.trim();
    if (!name || name === map.name) {
      setEditing(false);
      setError('');
      return;
    }
    setBusy(true);
    sending.current = true;
    try {
      await onRename(map, name);
      setEditing(false);
      setError('');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  if (!editing)
    return (
      <h2 className="ml-card-name" title={map.name}>
        <button className="map-name-button" type="button" disabled={disabled} title="Rename the map" onClick={() => { setError(''); setEditing(true); }}>
          {map.name}
        </button>
      </h2>
    );

  return (
    <div className="map-name-edit">
      <input
        aria-label={`New name for ${map.name}`}
        autoFocus
        className="map-name-input"
        defaultValue={map.name}
        disabled={busy}
        maxLength={64}
        onBlur={(event) => { if (!error) void commit(event.currentTarget.value); }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') void commit(event.currentTarget.value);
          if (event.key === 'Escape') { setEditing(false); setError(''); }
        }}
        onChange={() => error && setError('')}
      />
      {error ? <p className="dialog-error map-name-error" role="alert">{error}</p> : null}
    </div>
  );
}

function thumbnailCoordinateX(map: StoredMap, x: number) {
  return Math.max(0, Math.min(map.width || CANVAS_WIDTH, x));
}

function thumbnailCoordinateY(map: StoredMap, y: number) {
  return Math.max(0, Math.min(map.height || CANVAS_HEIGHT, y));
}

function thumbnailPercentX(map: StoredMap, x: number) {
  return (thumbnailCoordinateX(map, x) / (map.width || CANVAS_WIDTH)) * 100;
}

function thumbnailPercentY(map: StoredMap, y: number) {
  return (thumbnailCoordinateY(map, y) / (map.height || CANVAS_HEIGHT)) * 100;
}

function thumbnailPercentWidth(map: StoredMap, size: number) {
  return (size / (map.width || CANVAS_WIDTH)) * 100;
}

function thumbnailPercentHeight(map: StoredMap, size: number) {
  return (size / (map.height || CANVAS_HEIGHT)) * 100;
}

function thumbnailIconSize(map: StoredMap, size: number) {
  const scale = Math.max(1, Math.min((map.width || CANVAS_WIDTH) / 960, (map.height || CANVAS_HEIGHT) / 540));
  return Math.round(size * scale);
}

function MapThumbnail({ map }: { map: StoredMap }) {
  const terrainSource = map.data.map_surface ? `data:image/png;base64,${map.data.map_surface}` : uiAssets.logo;
  const capitalIndexes = new Set(map.data.capitals);
  const aspectRatio = (map.width || CANVAS_WIDTH) / (map.height || CANVAS_HEIGHT);

  return (
    <span className="map-thumb-frame">
      <span className="map-thumb-stage" style={{
        width: `${Math.min(1, aspectRatio / (16 / 9)) * 100}%`,
        height: `${Math.min(1, (16 / 9) / aspectRatio) * 100}%`,
      }}>
        <img alt={`${map.name} preview`} className="map-thumb-terrain" draggable={false} src={terrainSource} />
        <span aria-hidden="true" className="map-thumb-shade" />
        <span aria-hidden="true" className="map-thumb-overlay">
          {map.data.infantry.flatMap((team, teamIndex) => {
            const teamColor = teamColorForIndex(teamIndex);
            const sprite = spriteAssets[teamColor].infantry;
            return team.map(([x, y], unitIndex) => (
              <img
                alt=""
                className="map-thumb-sprite"
                draggable={false}
                key={`infantry-${teamIndex}-${unitIndex}`}
                  src={sprite}
                  style={{
                  height: `${thumbnailPercentHeight(map, thumbnailIconSize(map, SPRITE_SIZE))}%`,
                  left: `${thumbnailPercentX(map, x)}%`,
                  top: `${thumbnailPercentY(map, y)}%`,
                  width: `${thumbnailPercentWidth(map, thumbnailIconSize(map, SPRITE_SIZE))}%`,
                }}
              />
            ));
          })}
          {map.data.tanks.flatMap((team, teamIndex) => {
            const teamColor = teamColorForIndex(teamIndex);
            const sprite = spriteAssets[teamColor].tank;
            return team.map(([x, y], unitIndex) => (
              <img
                alt=""
                className="map-thumb-sprite"
                draggable={false}
                key={`tank-${teamIndex}-${unitIndex}`}
                  src={sprite}
                  style={{
                  height: `${thumbnailPercentHeight(map, thumbnailIconSize(map, SPRITE_SIZE + 4))}%`,
                  left: `${thumbnailPercentX(map, x)}%`,
                  top: `${thumbnailPercentY(map, y)}%`,
                  width: `${thumbnailPercentWidth(map, thumbnailIconSize(map, SPRITE_SIZE + 4))}%`,
                }}
              />
            ));
          })}
          {map.data.cities.map(([x, y], cityIndex) => {
            const isCapital = capitalIndexes.has(cityIndex);
            const size = thumbnailIconSize(map, isCapital ? CAPITAL_SIZE : CITY_SIZE);

            return (
              <img
                alt=""
                className="map-thumb-sprite"
                draggable={false}
                key={`city-${cityIndex}`}
                src={isCapital ? uiAssets.capital : uiAssets.city}
                style={{
                  height: `${thumbnailPercentHeight(map, size)}%`,
                  left: `${thumbnailPercentX(map, x)}%`,
                  top: `${thumbnailPercentY(map, y)}%`,
                  width: `${thumbnailPercentWidth(map, size)}%`,
                }}
              />
            );
          })}
        </span>
      </span>
    </span>
  );
}

/** When a map was last changed, in words: "2 hours ago", "yesterday", a date. */
function editedLabel(timestamp: number, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const day = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  if (day(now) - day(timestamp) <= 86_400_000) return 'yesterday';
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(timestamp).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

function mapSummary(map: StoredMap) {
  if (map.status === 'invalid') return `Edited ${editedLabel(map.updatedAt)}`;
  const units = map.data.infantry.reduce((total, team) => total + team.length, 0) + map.data.tanks.reduce((total, team) => total + team.length, 0);
  const cities = map.data.cities.length;
  return [`${map.teamCount} teams`, `${units} ${units === 1 ? 'unit' : 'units'}`, `${cities} ${cities === 1 ? 'city' : 'cities'}`, `edited ${editedLabel(map.updatedAt)}`].join(' · ');
}

const ICONS = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  more: <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>,
  select: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  check: <path d="m6 12.5 4 4 8-9" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
};
const Icon = ({ name }: { name: keyof typeof ICONS }) => (
  <svg aria-hidden="true" className="ml-icon" viewBox="0 0 24 24">{ICONS[name]}</svg>
);

type SortOrder = 'edited' | 'name';

export function MapLibrary({
  maps,
  loading,
  onAdd,
  onDeleteSelected,
  onEdit,
  onRename,
  onDuplicate,
}: MapLibraryProps) {
  const [query, setQuery] = useState('');
  const [teams, setTeams] = useState<ReadonlySet<number>>(() => new Set(TEAM_COUNTS));
  const [sort, setSort] = useState<SortOrder>('edited');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameRequests, setRenameRequests] = useState<Record<string, number>>({});
  const [selecting, setSelecting] = useState(false);
  const [selectedMapIds, setSelectedMapIds] = useState<Set<string>>(() => new Set());

  // The card menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!menuFor) return;
    const close = (event: Event) => {
      if (event instanceof window.KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof window.MouseEvent && (event.target as Element | null)?.closest('.ml-menu, .ml-more')) return;
      setMenuFor(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuFor]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = maps.filter((map) => (teams.size === TEAM_COUNTS.length || teams.has(map.teamCount)) && words.every((word) => map.name.toLowerCase().includes(word)));
    return sort === 'name' ? [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : list;
  }, [maps, query, teams, sort]);

  const teamTotals = useMemo(() => {
    const totals: Record<number, number> = {};
    for (const map of maps) totals[map.teamCount] = (totals[map.teamCount] ?? 0) + 1;
    return totals;
  }, [maps]);

  function toggleTeams(count: number) {
    setTeams((current) => {
      const next = new Set(current);
      if (next.has(count)) next.delete(count);
      else next.add(count);
      return next;
    });
  }

  function closeOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== 'Escape' || !event.currentTarget.open) return;
    event.currentTarget.open = false;
    event.currentTarget.querySelector('summary')?.focus();
  }

  const selectedMaps = maps.filter((map) => selectedMapIds.has(map.id));
  const selectedCount = selectedMaps.length;

  function toggleSelecting() {
    setSelecting((current) => {
      if (current) setSelectedMapIds(new Set());
      return !current;
    });
  }

  function toggleMapSelection(mapId: string) {
    setSelectedMapIds((current) => {
      const next = new Set(current);
      if (next.has(mapId)) next.delete(mapId);
      else next.add(mapId);
      return next;
    });
  }

  function deleteMaps(list: StoredMap[]) {
    if (!list.length) return;
    const label = list.length === 1 ? list[0].name : `${list.length} maps`;
    // No confirmation: the library offers Undo for a few seconds before the files go.
    onDeleteSelected(list.map((map) => map.id), label);
    setSelectedMapIds(new Set());
    setSelecting(false);
  }

  // The same summary as the Replays page filters: "Teams: All", "Teams: 2, 3".
  const teamSummary = teams.size === TEAM_COUNTS.length ? 'Teams: All' : !teams.size ? 'Teams: None' : `Teams: ${TEAM_COUNTS.filter((count) => teams.has(count)).join(', ')}`;
  const allSelected = shown.length > 0 && shown.every((map) => selectedMapIds.has(map.id));

  return (
    <section className="ml-shell" aria-labelledby="mapLibraryTitle">
      {selecting ? (
        <header className="ml-header is-selecting" role="region" aria-label="Selected maps">
          <label className="ml-select-all">
            <input
              type="checkbox"
              aria-label="Select all maps"
              checked={allSelected}
              ref={(input) => { if (input) input.indeterminate = selectedCount > 0 && !allSelected; }}
              onChange={() => setSelectedMapIds(allSelected ? new Set() : new Set(shown.map((map) => map.id)))}
            />
            <strong className="ml-label">{selectedCount} selected</strong>
          </label>
          <button type="button" className="ml-delete" disabled={!selectedCount} onClick={() => deleteMaps(selectedMaps)}>
            <Icon name="trash" /><span className="ml-label">Delete</span>
          </button>
          <button className="ml-icon-button" type="button" aria-label="Stop selecting" title="Stop selecting" onClick={toggleSelecting}><Icon name="close" /></button>
        </header>
      ) : (
        <header className="ml-header">
          <div className="ml-heading">
            <h1 id="mapLibraryTitle">Your maps</h1>
            <span>{loading ? '' : `${maps.length} ${maps.length === 1 ? 'map' : 'maps'}`}</span>
          </div>
          <label className="ml-search">
            <Icon name="search" />
            <span className="ml-sr">Search maps</span>
            <input type="search" placeholder="Search maps" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <details className="filter-dropdown" onKeyDown={closeOnEscape}>
            <summary aria-label="Team filters"><span className="ml-label">{teamSummary}</span></summary>
            <div className="filter-menu" role="group" aria-label="Team filters">
              {TEAM_COUNTS.map((count) => (
                <label key={count}>
                  <input type="checkbox" checked={teams.has(count)} onChange={() => toggleTeams(count)} />
                  <span>{count} teams</span>
                  <span className="filter-count">{teamTotals[count] ?? 0}</span>
                </label>
              ))}
            </div>
          </details>
          <details className="filter-dropdown" onKeyDown={closeOnEscape}>
            <summary aria-label="Sort order"><span className="ml-label">Sort: {sort === 'name' ? 'Name' : 'Last edited'}</span></summary>
            <div className="filter-menu" role="radiogroup" aria-label="Sort order">
              {(['edited', 'name'] as SortOrder[]).map((value) => (
                <label key={value}>
                  <input type="radio" name="mapSort" checked={sort === value} onChange={(event) => { setSort(value); event.currentTarget.closest('details')?.removeAttribute('open'); }} />
                  <span>{value === 'name' ? 'Name' : 'Last edited'}</span>
                </label>
              ))}
            </div>
          </details>
          <button className="ml-button" type="button" disabled={!maps.length} onClick={toggleSelecting}><Icon name="select" /><span className="ml-label">Select</span></button>
          <button className="ml-primary" type="button" onClick={onAdd}><Icon name="plus" /><span className="ml-label">Add map</span></button>
        </header>
      )}

      {loading && !maps.length ? (
        <div className="ml-empty"><div className="loading-pulse" /><p>Loading your maps...</p></div>
      ) : !maps.length ? (
        <div className="ml-empty">
          <h2>No maps yet</h2>
                  </div>
      ) : !shown.length ? (
        <div className="ml-empty"><p>No maps match.</p></div>
      ) : (
        <div className="ml-grid">
          {shown.map((map) => {
            const selected = selectedMapIds.has(map.id);
            const unreadable = map.status === 'invalid';
            return (
              <article className={`ml-card${selected ? ' is-selected' : ''}${menuFor === map.id ? ' has-menu' : ''}`} key={map.id}>
                <div className="ml-thumb">
                  <button className="ml-thumb-open" type="button" aria-label={selecting ? `Select ${map.name}` : `Edit ${map.name}`} aria-pressed={selecting ? selected : undefined} disabled={!selecting && unreadable} onClick={() => (selecting ? toggleMapSelection(map.id) : onEdit(map.id))}>
                    <MapThumbnail map={map} />
                  </button>
                  {selecting ? (
                    <span className="ml-check" aria-hidden="true">{selected ? <Icon name="check" /> : null}</span>
                  ) : (
                    <div className="ml-actions">
                      <div className="ml-actions-side">
                        <button className="ml-action ml-more" type="button" aria-label={`More actions for ${map.name}`} title="Rename, duplicate, delete" aria-haspopup="menu" aria-expanded={menuFor === map.id} onClick={() => setMenuFor(menuFor === map.id ? null : map.id)}><Icon name="more" /></button>
                      </div>
                      {menuFor === map.id ? (
                        <div className="ml-menu" role="menu">
                          <button type="button" role="menuitem" disabled={unreadable} onClick={() => { setMenuFor(null); setRenameRequests((current) => ({ ...current, [map.id]: (current[map.id] ?? 0) + 1 })); }}>Rename</button>
                          <button type="button" role="menuitem" disabled={unreadable} onClick={() => { setMenuFor(null); onDuplicate(map); }}>Duplicate</button>
                          <button type="button" role="menuitem" className="ml-danger" onClick={() => { setMenuFor(null); deleteMaps([map]); }}>Delete</button>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
                <div className="ml-card-body">
                  <div className="ml-card-title">
                    <MapName map={map} disabled={selecting || unreadable} editRequest={renameRequests[map.id] ?? 0} onRename={onRename} />
                    {unreadable ? <span className="ml-badge is-error" title={map.issue ?? undefined}>Unreadable</span>
                      : map.issue ? <span className="ml-badge" title={map.issue}>Not playable</span> : null}
                  </div>
                  <p className="ml-card-meta" title={map.issue ?? map.fileName}>{unreadable ? map.issue : mapSummary(map)}</p>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
