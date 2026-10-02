export const MATCH_TYPES = ["1v1", "3P FFA", "4P FFA"];
export type MapSource = "vanilla" | "custom";
export type ReplayFilterRecord = {
  names: string[];
  normalizedNames: string[];
  matchType: string;
  durationSeconds: number;
  modified: number;
  winnerIndex: number;
  isDraw: boolean;
  mapKey: string | null;
  mapLabel: string;
  mapSource: MapSource;
  thumbnailKey?: string | null;
  thumbnailDataUrl?: string | null;
};
export type ReplayFilters = {
  query: string;
  enabledTypes: Set<string>;
  sources: Set<MapSource>;
  durationRange: { min: number; max: number };
  mapKey: string | null;
  player: string | null;
};
type SuggestionBase = { name: string; replayCount: number; latestModified: number; rank: number };
export type PlayerSuggestion = SuggestionBase & {
  kind: "player"; key: string; winCount: number; lossCount: number; drawCount: number; opponents: string[];
};
export type MapSuggestion = SuggestionBase & {
  kind: "map"; key: string; source: MapSource; thumbnailKey?: string | null; thumbnailDataUrl?: string | null;
};
export type ReplaySuggestion = PlayerSuggestion | MapSuggestion;

export const normalize = (text: string) => text.trim().toLocaleLowerCase();

export function matchesReplay(record: ReplayFilterRecord, filters: ReplayFilters, omit?: "player" | "map") {
  return filters.enabledTypes.has(record.matchType)
    && filters.sources.has(record.mapSource)
    && record.durationSeconds >= filters.durationRange.min && record.durationSeconds <= filters.durationRange.max
    && (omit === "map" || !filters.mapKey || filters.mapKey === record.mapKey)
    && (omit === "player" || !filters.player || record.normalizedNames.includes(filters.player))
    && (omit !== undefined || !filters.query || record.normalizedNames.some(name => name.includes(filters.query))
      || normalize(record.mapLabel).includes(filters.query)
      || (record.mapSource === "custom" && !!record.mapKey?.slice(7).includes(filters.query.replace(/^#/, ""))));
}

function matchRank(name: string, query: string) {
  const value = normalize(name);
  const needle = query;
  if (!needle || value === needle) return 0;
  if (value.startsWith(needle)) return 1;
  if (value.split(/\s+/).some(part => part.startsWith(needle))) return 2;
  return value.includes(needle) ? 3 : Infinity;
}

// Each group ignores its own selected value, so the user can replace it while
// retaining the other filters. Counts always describe that prospective selection.
export function replaySuggestions(records: ReplayFilterRecord[], filters: ReplayFilters, limit = 8): ReplaySuggestion[] {
  const players = new Map<string, PlayerSuggestion & { opponentCounts: Map<string, number> }>();
  const maps = new Map<string, MapSuggestion>();
  for (const record of records) {
    if (matchesReplay(record, filters, "player")) {
      record.names.forEach((name, index) => {
        const key = record.normalizedNames[index];
        const rank = matchRank(name, filters.query);
        if (!Number.isFinite(rank)) return;
        const item = players.get(key) ?? { kind: "player", key, name, rank, replayCount: 0, latestModified: 0,
          winCount: 0, lossCount: 0, drawCount: 0, opponents: [], opponentCounts: new Map<string, number>() };
        item.replayCount++;
        item.winCount += Number(record.winnerIndex === index);
        item.lossCount += Number(record.winnerIndex >= 0 && record.winnerIndex !== index);
        item.drawCount += Number(record.isDraw);
        item.latestModified = Math.max(item.latestModified, record.modified);
        record.names.forEach((opponent, opponentIndex) => {
          if (opponentIndex !== index) item.opponentCounts.set(opponent, (item.opponentCounts.get(opponent) ?? 0) + 1);
        });
        players.set(key, item);
      });
    }
    if (record.mapKey && matchesReplay(record, filters, "map")) {
      const rank = Math.min(matchRank(record.mapLabel, filters.query), record.mapSource === "custom"
        ? matchRank(record.mapKey.slice(7), filters.query.replace(/^#/, "")) : Infinity);
      if (!Number.isFinite(rank)) continue;
      const item = maps.get(record.mapKey) ?? { kind: "map", key: record.mapKey, name: record.mapLabel, source: record.mapSource,
        rank, replayCount: 0, latestModified: 0, thumbnailKey: record.thumbnailKey, thumbnailDataUrl: record.thumbnailDataUrl };
      item.replayCount++;
      item.latestModified = Math.max(item.latestModified, record.modified);
      maps.set(record.mapKey, item);
    }
  }
  const sort = (a: SuggestionBase, b: SuggestionBase) => a.rank - b.rank || b.replayCount - a.replayCount
    || b.latestModified - a.latestModified || a.name.localeCompare(b.name);
  const playerItems = [...players.values()].sort(sort).slice(0, limit).map(({ opponentCounts, ...item }) => ({ ...item,
    opponents: [...opponentCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name) }));
  return [...playerItems, ...[...maps.values()].sort(sort).slice(0, limit)];
}

export function toggleMatchType(current: Set<string>, type: string) {
  return current.size === 1 && current.has(type) ? new Set(MATCH_TYPES) : new Set([type]);
}
