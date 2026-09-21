export type Board = 'elo' | 'world';
export type Player = { rank: number; nickname: string; value: number; faction: string };
export type Snapshot = { capturedAt: number; refreshIntervalSeconds?: number; activity?: Record<string, number>; elo: Player[]; world: Player[] };
export type HistoryPoint = { capturedAt: number; players: { nickname: string; rank: number | null; value: number | null }[] };
export type History = { rows: HistoryPoint[]; from: number; to: number; step: number };
type Entry<T> = { data: T; etag: string; expires: number; saved: number };
const EXAMPLES = import.meta.env?.DEV && import.meta.env?.VITE_EXAMPLE_DATA === '1';
const API = 'https://wod-nations-map.moreofdots.workers.dev';
const PREFIX = 'mod.leaderboard.v2:';
const pending = new Map<string, Promise<unknown>>();
const memory = new Map<string, Entry<unknown>>();
const DEFAULT_REFRESH_INTERVAL_SECONDS = 1800;
const MIN_REFRESH_INTERVAL_SECONDS = 60;
const MAX_REFRESH_INTERVAL_SECONDS = 86400;
const STALE_RETRY_MS = 60_000;

export function cacheExpiry(data: unknown, now = Date.now()): number {
  const snapshot = data as Partial<Snapshot> | null;
  const configured = Number(snapshot?.refreshIntervalSeconds);
  const interval = Number.isFinite(configured) && configured >= MIN_REFRESH_INTERVAL_SECONDS && configured <= MAX_REFRESH_INTERVAL_SECONDS
    ? configured
    : DEFAULT_REFRESH_INTERVAL_SECONDS;
  const capturedAt = Number(snapshot?.capturedAt);
  const nextCapture = Number.isFinite(capturedAt) ? (capturedAt + interval) * 1000 : now + interval * 1000;
  return Math.max(now + STALE_RETRY_MS, Math.min(now + interval * 1000, nextCapture));
}

export function cached<T>(path: string): Entry<T> | null {
  if (EXAMPLES) return null;
  if (memory.has(path)) return memory.get(path) as Entry<T>;
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + path) ?? 'null') as Entry<T> | null;
    return value && Number.isFinite(value.expires) && value.data ? value : null;
  } catch { return null; }
}

function save<T>(path: string, entry: Entry<T>) {
  memory.delete(path);
  memory.set(path, entry);
  const older = [...memory.keys()].filter((key) => key !== '/v1/leaderboard');
  older.slice(0, Math.max(0, older.length - 12)).forEach((key) => memory.delete(key));
  try {
    localStorage.setItem(PREFIX + path, JSON.stringify(entry));
    const histories = Object.keys(localStorage).filter((key) => key.startsWith(PREFIX) && key !== PREFIX + '/v1/leaderboard');
    histories.sort((a, b) => (JSON.parse(localStorage.getItem(b)!).saved ?? 0) - (JSON.parse(localStorage.getItem(a)!).saved ?? 0));
    histories.slice(12).forEach((key) => localStorage.removeItem(key));
  } catch { /* Storage can be disabled or full. Network data remains usable. */ }
}

export async function retrieve<T>(path: string, force = false): Promise<T> {
  if (EXAMPLES) return (await import('../dev/examples')).exampleLeaderboard<T>(path);
  const existing = cached<T>(path);
  if (!force && existing && existing.expires > Date.now()) return existing.data;
  if (pending.has(path)) return pending.get(path) as Promise<T>;
  const task = (async () => {
    const response = await fetch(API + path, {
      headers: existing?.etag ? { 'If-None-Match': existing.etag } : {},
      credentials: 'omit', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok && response.status !== 304) throw new Error(`Leaderboard is unavailable (${response.status}). Try again shortly.`);
    const data = response.status === 304 && existing ? existing.data : await response.json() as T;
    const expires = cacheExpiry(data);
    save(path, { data, etag: response.headers.get('ETag') ?? existing?.etag ?? '', expires, saved: Date.now() });
    return data;
  })();
  pending.set(path, task);
  try { return await task; } finally { pending.delete(path); }
}

export function historyPath(board: Board, players: string[], days: number, to: number) {
  const query = new URLSearchParams({ board, days: String(days), to: String(to) });
  [...new Set(players)].sort().forEach((player) => query.append('player', player));
  return '/v1/leaderboard/players?' + query;
}


export type Refresh = Snapshot & { history: (History & { replaceFrom: number }) | null };

export function mergeHistory(previous: History | null, delta: History & { replaceFrom: number }): History {
  const rows = new Map<number, HistoryPoint>();
  for (const row of previous?.rows ?? []) {
    if (row.capturedAt >= delta.from && row.capturedAt < delta.replaceFrom) rows.set(row.capturedAt, row);
  }
  for (const row of delta.rows) rows.set(row.capturedAt, row);
  return { ...delta, rows: [...rows.values()].sort((a, b) => a.capturedAt - b.capturedAt) };
}

export async function refreshLeaderboard(board: Board, players: string[], days: number, force = false): Promise<Refresh> {
  const query = new URLSearchParams({ board, days: String(days) });
  [...new Set(players)].sort().forEach(name => query.append('player', name));
  const key = '/v1/leaderboard/refresh?' + query;
  const existing = cached<Refresh>(key);
  if (!force && existing && existing.expires > Date.now()) return existing.data;
  if (pending.has(key)) return pending.get(key) as Promise<Refresh>;
  const task = (async () => {
    let data: Refresh;
    if (EXAMPLES) {
      const latest = await retrieve<Snapshot>('/v1/leaderboard');
      const history = players.length ? await retrieve<History>(historyPath(board, players, days, latest.capturedAt)) : null;
      data = { ...latest, history: history ? { ...history, replaceFrom: history.from } : null };
    } else {
      if (existing?.data.history) query.set('since', String(existing.data.history.to));
      const response = await fetch(API + '/v1/leaderboard/refresh?' + query, {
        credentials: 'omit', signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('Leaderboard is unavailable (' + response.status + '). Try again shortly.');
      data = await response.json() as Refresh;
      if (!Number.isFinite(data.capturedAt) || !Array.isArray(data.elo) || !Array.isArray(data.world)) throw new Error('Invalid leaderboard response.');
      if (data.history) data.history = { ...data.history, ...mergeHistory(existing?.data.history ?? null, data.history) };
    }
    const entry = { data, expires: cacheExpiry(data), etag: '', saved: Date.now() };
    save(key, entry);
    save('/v1/leaderboard', { ...entry, data: { ...data, history: null } });
    return data;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
