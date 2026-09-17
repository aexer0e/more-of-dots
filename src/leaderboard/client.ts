export type Board = 'elo' | 'world';
export type Player = { rank: number; nickname: string; value: number; faction: string };
export type Snapshot = { capturedAt: number; elo: Player[]; world: Player[] };
export type HistoryPoint = { capturedAt: number; players: { nickname: string; rank: number | null; value: number | null }[] };
export type History = { rows: HistoryPoint[]; from: number; to: number; step: number };
type Entry<T> = { data: T; etag: string; expires: number; saved: number };
const EXAMPLES = import.meta.env?.DEV && import.meta.env?.VITE_EXAMPLE_DATA === '1';
const API = 'https://wod-nations-map.moreofdots.workers.dev';
const PREFIX = 'mod.leaderboard.v1:';
const pending = new Map<string, Promise<unknown>>();
const memory = new Map<string, Entry<unknown>>();

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

export async function retrieve<T>(path: string): Promise<T> {
  if (EXAMPLES) return (await import('../dev/examples')).exampleLeaderboard<T>(path);
  const existing = cached<T>(path);
  if (existing && existing.expires > Date.now()) return existing.data;
  if (pending.has(path)) return pending.get(path) as Promise<T>;
  const task = (async () => {
    const response = await fetch(API + path, {
      headers: existing?.etag ? { 'If-None-Match': existing.etag } : {},
      credentials: 'omit', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok && response.status !== 304) throw new Error(`Leaderboard is unavailable (${response.status}). Try again shortly.`);
    const data = response.status === 304 && existing ? existing.data : await response.json() as T;
    const stamp = (data as Snapshot).capturedAt;
    const nextCapture = Number.isFinite(stamp) ? (stamp + 1800) * 1000 : Date.now() + 1800_000;
    const expires = Math.max(Date.now() + 300_000, Math.min(Date.now() + 1800_000, nextCapture));
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
