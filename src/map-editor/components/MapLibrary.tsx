import { useState } from 'react';
import { CANVAS_HEIGHT, CANVAS_WIDTH, CAPITAL_SIZE, CITY_SIZE, SPRITE_SIZE, teamColorForIndex } from '../lib/constants';
import { modeLabel, formatUpdatedAt } from '../lib/mapCodec';
import type { StoredMap } from '../lib/types';
import { spriteAssets, uiAssets } from '../lib/assets';

interface MapLibraryProps {
  maps: StoredMap[];
  loading: boolean;
  onCreate: () => void;
  onRefresh: () => void;
  onDeleteSelected: (fileNames: string[]) => void;
  onEdit: (mapId: string) => void;
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
          {map.data.motorised.flatMap((team, teamIndex) => {
            const teamColor = teamColorForIndex(teamIndex);
            const sprite = spriteAssets[teamColor].motorised;
            return team.map(([x, y], unitIndex) => (
              <img
                alt=""
                className="map-thumb-sprite"
                draggable={false}
                key={`motorised-${teamIndex}-${unitIndex}`}
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

function ActionIcon() {
  return (
    <svg aria-hidden="true" className="library-action-icon" viewBox="0 0 24 24">
      <path d="M4 16.8V20h3.2L18 9.2 14.8 6 4 16.8Z" fill="currentColor" />
      <path d="m13.9 6.9 3.2 3.2" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function MapLibrary({
  maps,
  loading,
  onCreate,
  onRefresh,
  onDeleteSelected,
  onEdit,
}: MapLibraryProps) {
  const [selecting, setSelecting] = useState(false);
  const [selectedMapIds, setSelectedMapIds] = useState<Set<string>>(() => new Set());
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

  function selectAllMaps() {
    setSelectedMapIds(new Set(maps.map((map) => map.id)));
  }

  function clearSelection() {
    setSelectedMapIds(new Set());
  }

  function deleteSelectedMaps() {
    if (!selectedCount) return;
    const label = selectedCount === 1 ? selectedMaps[0]?.fileName : `${selectedCount} maps`;
    if (!window.confirm(`Delete ${label}? Published maps will be removed from the game. Deleting a draft keeps any published copy. No backup will be kept. This cannot be undone.`)) return;
    onDeleteSelected(selectedMaps.map((map) => map.id));
    setSelectedMapIds(new Set());
    setSelecting(false);
  }

  return (
    <section className="library-shell">
      <header className="library-toolbar">
        <div className="brand-block">
          <img alt="" src={uiAssets.appIcon} />
          <div className="library-toolbar-copy">
            <h1>Map Editor</h1>
            <p>Maps and drafts</p>
          </div>
        </div>
        <div className="library-toolbar-actions">
          <button className="secondary-button compact" disabled={loading} type="button" onClick={onRefresh}>
            Refresh
          </button>
          <button className="secondary-button compact" aria-pressed={selecting} type="button" onClick={toggleSelecting}>
            {selecting ? 'Cancel Select' : 'Select'}
          </button>
          <button className="primary-button compact" type="button" onClick={onCreate}>
            New Map
          </button>
        </div>
      </header>

      {selecting ? (
        <div className="library-selection-bar">
          <span>{selectedCount} selected</span>
          <div className="library-selection-actions">
            <button className="secondary-button compact" type="button" onClick={selectAllMaps}>
              Select All
            </button>
            <button className="secondary-button compact" type="button" onClick={clearSelection}>
              Clear
            </button>
            <button className="danger-button compact" disabled={!selectedCount} type="button" onClick={deleteSelectedMaps}>
              Delete
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="empty-state compact">
          <div className="loading-pulse" />
          <p>Loading local maps...</p>
        </div>
      ) : maps.length === 0 ? (
        <div className="empty-state">
          <img alt="WoD Map Editor logo" src={uiAssets.logo} />
          <h3>No maps saved yet</h3>
          <p>Create a map or import one to get started.</p>
        </div>
      ) : (
        <div className="map-grid">
          {maps.map((map) => {
            const selected = selectedMapIds.has(map.id);
            return (
              <article className={`map-card${selected ? ' selected' : ''}`} key={map.id}>
                {selecting ? (
                  <label className="map-select-toggle">
                    <input checked={selected} type="checkbox" onChange={() => toggleMapSelection(map.id)} />
                    <span>{selected ? 'Selected' : 'Select map'}</span>
                  </label>
                ) : null}
                <button className="map-thumb" type="button" disabled={!selecting && map.status === 'invalid'} onClick={() => (selecting ? toggleMapSelection(map.id) : onEdit(map.id))}>
                  <MapThumbnail map={map} />
                  <span className="map-preview-badges">
                    <span className="map-status-pill" data-status={map.status ?? 'published'}>
                      <span aria-hidden="true" className="map-status-dot" />
                      {map.status === 'draft' ? 'Draft' : map.status === 'invalid' ? 'Unreadable map' : 'In game'}
                    </span>
                    <span className="map-mode-pill" title={`${modeLabel(map.data.mode)} / ${map.teamCount} teams`}>
                      {map.data.mode === 'v3' ? '3P' : map.data.mode === 'v4' ? '4P' : '1v1'}
                    </span>
                  </span>
                </button>
                <div className="map-card-body">
                  <div className="map-card-head">
                    <h4 title={map.name}>{map.name}</h4>
                    <div className="map-card-actions">
                      {selecting ? (
                        <button className="secondary-button compact" type="button" aria-pressed={selected} onClick={() => toggleMapSelection(map.id)}>
                          {selected ? 'Selected' : 'Select'}
                        </button>
                      ) : (
                        <>
                          <button className="secondary-button compact" disabled={map.status === 'invalid'} aria-label={`Edit ${map.name}`} type="button" onClick={() => onEdit(map.id)}>
                            <ActionIcon />Edit
                          </button>
                          <button className="danger-button compact" aria-label={`Delete ${map.name}`} type="button" onClick={() => {
                            const detail = map.status === 'draft' ? ' Any published copy stays in the game.' : map.gameFilePath ? ' Its game file and thumbnail will be deleted.' : '';
                            if (window.confirm(`Delete ${map.fileName}?${detail} No backup will be kept. This cannot be undone.`)) onDeleteSelected([map.id]);
                          }}>
                            <svg aria-hidden="true" className="library-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
                            </svg>Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="map-card-meta">
                    <p className="map-card-filename" title={map.fileName}>{map.fileName}</p>
                    <p className="map-card-updated">{map.width}×{map.height} · Updated {formatUpdatedAt(map.updatedAt)}</p>
                  </div>
                  {map.issue && <p className="dialog-error">{map.issue}</p>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
