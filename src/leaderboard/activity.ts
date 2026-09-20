import type { Player, Snapshot } from './client';

export type TableSort = { key: 'rank' | 'activity'; descending: boolean };

// Rank changes alone can be caused by other players and are not activity.
export function lastActivities(snapshots: Snapshot[]) {
  const activity = new Map<string, number>();
  const previous = { elo: new Map<string, number>(), world: new Map<string, number>() };
  for (const snapshot of [...snapshots].sort((a, b) => a.capturedAt - b.capturedAt)) {
    for (const board of ['elo', 'world'] as const) {
      for (const player of snapshot[board]) {
        const value = previous[board].get(player.nickname);
        if (value != null && value !== player.value) activity.set(player.nickname, snapshot.capturedAt);
      }
      previous[board] = new Map(snapshot[board].map((p) => [p.nickname, p.value]));
    }
  }
  return activity;
}

export function sortPlayers(players: Player[], activity: Map<string, number>, sort: TableSort) {
  return [...players].sort((a, b) => {
    if (sort.key === 'rank') return (a.rank - b.rank) * (sort.descending ? -1 : 1);
    const left = activity.get(a.nickname), right = activity.get(b.nickname);
    if (left == null || right == null) return left == null && right == null ? a.rank - b.rank : left == null ? 1 : -1;
    return (left - right) * (sort.descending ? -1 : 1) || a.rank - b.rank;
  });
}

export function activityLabel(stamp: number, now: number) {
  const minutes = Math.max(0, Math.floor((now / 1000 - stamp) / 60));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function activityColor(stamp: number | undefined, now: number) {
  const minutes = stamp == null ? 4320 : Math.max(5, Math.min(4320, (now / 1000 - stamp) / 60));
  // Two logarithmic segments place five hours exactly halfway through the fade.
  const strength = minutes <= 300
    ? 1 - .5 * Math.log(minutes / 5) / Math.log(300 / 5)
    : .5 * (1 - Math.log(minutes / 300) / Math.log(4320 / 300));
  return `hsl(200 ${(strength * 70).toFixed(2)}% ${(56 + strength * 32).toFixed(2)}%)`;
}
