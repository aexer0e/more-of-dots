// Network and storage for the Nations tab. Requests follow the 30-minute capture
// schedule: one incremental summary call per capture, the ownership map only when its
// hash changes, older history once (one row per day) and economy data only on demand.
import {
  compactRow, dailyRows, latestOf, mergeRows, rangeStart, RECENT_SECONDS, settle,
  type ApiRow, type Latest, type Range, type Row,
} from './data';

const EXAMPLES = import.meta.env?.DEV && import.meta.env?.VITE_EXAMPLE_DATA === '1';
export const API = 'https://wod-nations-map.moreofdots.workers.dev';
const STORE_KEY = 'mod.nations.v1';
const MAP_KEY = 'mod.nations.map.v1';
const PAGE_LIMIT = 1000;

export type Economy = { capturedAt: number; nations: { nation: number; cash: number; netWorth: number; players: number }[] };
export type Store = {
  recent: Row[];
  daily: Row[];
  /** Every capture at or after this time is in `recent` or `daily`. */
  historyFrom: number | null;
  oldest: number | null;
  latest: Latest | null;
  lastAttempt: number;
  economy: Economy | null;
};
export type MapPayload = { hash: string; encoding: string; width: number; height: number; playablePixels: number | null; bytes: Uint8Array };

const empty = (): Store => ({ recent: [], daily: [], historyFrom: null, oldest: null, latest: null, lastAttempt: 0, economy: null });
let memory: Store | null = null;
const pending = new Map<string, Promise<unknown>>();

function read<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null; } catch { return null; }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be full or disabled; data stays in memory. */ }
}

export function stored(): Store {
  if (memory) return memory;
  const saved = read<Store>(STORE_KEY);
  memory = saved && Array.isArray(saved.recent) && Array.isArray(saved.daily) ? { ...empty(), ...saved } : empty();
  return memory;
}
function persist(store: Store) {
  memory = store;
  write(STORE_KEY, store);
}

function once<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const promise = task().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

// The campaign routes are public; no credentials are sent.
async function request(path: string): Promise<Response> {
  if (EXAMPLES) return (await import('../dev/examples')).exampleNations(path);
  const response = await fetch(new URL(path, API), { credentials: 'omit', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `The campaign map is unavailable (${response.status}). Try again shortly.`);
  }
  return response;
}

// Timeline

type SummaryPage = { rows: ApiRow[]; oldestCapturedAt: number | null; latestCapturedAt: number | null };
type TimelinePage = { rows: ApiRow[]; nextBefore: number | null };

/** One incremental request: every capture after the newest one already stored. */
export function sync(): Promise<Store> {
  return once('sync', async () => {
    const store = stored();
    const now = Math.floor(Date.now() / 1000);
    const known = store.latest?.capturedAt ?? null;
    // After a long absence only the last week is fetched at full resolution; older days
    // are filled at one per day if a longer range is opened.
    const after = Math.max(known == null ? 0 : known + 1, now - RECENT_SECONDS);
    const attempt = Date.now();
    let page: SummaryPage;
    try {
      page = await (await request(`/v1/timeline/summary?after=${after}`)).json() as SummaryPage;
    } catch (error) {
      persist({ ...stored(), lastAttempt: attempt });
      throw error;
    }
    const rows = page.rows.map(compactRow).filter((row): row is Row => row != null);
    const next: Store = { ...stored(), lastAttempt: attempt, oldest: page.oldestCapturedAt ?? store.oldest };
    if (known == null || after > known + 1) next.historyFrom = after;
    const newest = page.rows.at(-1);
    if (newest && (known == null || newest.capturedAt > known)) next.latest = latestOf(newest);
    const latest = next.latest?.capturedAt ?? now;
    Object.assign(next, settle(mergeRows(next.recent, rows), next.daily, latest));
    persist(next);
    return next;
  });
}

/** Loads the history a long range needs, once, keeping one capture per day. */
export function ensureHistory(range: Range): Promise<Store> {
  return once('history:' + range, async () => {
    const store = stored();
    const latest = store.latest?.capturedAt;
    if (latest == null || store.historyFrom == null) return store;
    const target = rangeStart(range, latest, store.oldest);
    if (target == null || store.historyFrom <= target) return store;
    const to = store.historyFrom - 1;
    const collected: Row[] = [];
    let before: number | null = null;
    do {
      const query = new URLSearchParams({ from: String(target), to: String(to), limit: String(PAGE_LIMIT) });
      if (before != null) query.set('before', String(before));
      const page = await (await request('/v1/timeline?' + query)).json() as TimelinePage;
      collected.push(...dailyRows(page.rows.map(compactRow).filter((row): row is Row => row != null)));
      before = page.nextBefore;
    } while (before != null);
    const next = { ...stored(), historyFrom: target, daily: dailyRows(mergeRows(stored().daily, collected)) };
    persist(next);
    return next;
  });
}

// Map

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
function fromBase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The latest ownership map. Map URLs are immutable, so a stored copy is reused until the hash changes. */
export function loadMap(latest: Latest): Promise<MapPayload> {
  return once('map:' + latest.mapHash, async () => {
    const saved = read<Omit<MapPayload, 'bytes'> & { data: string }>(MAP_KEY);
    if (saved?.hash === latest.mapHash && saved.data) return { ...saved, bytes: fromBase64(saved.data) };
    const bytes = new Uint8Array(await (await request(latest.mapUrl)).arrayBuffer());
    const payload = { hash: latest.mapHash, encoding: latest.encoding, width: latest.width, height: latest.height, playablePixels: latest.playablePixels };
    write(MAP_KEY, { ...payload, data: toBase64(bytes) });
    return { ...payload, bytes };
  });
}

// Economy

type NationsResponse = { capturedAt: number; nations: { nation: number; cash: number; net_worth: number; players: number }[] };

/** Nation cash, net worth and players. Fetched at most once per capture, and only when shown. */
export function loadEconomy(): Promise<Economy | null> {
  return once('economy', async () => {
    const store = stored();
    const latest = store.latest?.capturedAt;
    if (store.economy && latest != null && store.economy.capturedAt >= latest - 60) return store.economy;
    let body: NationsResponse;
    try {
      body = await (await request('/v1/nations')).json() as NationsResponse;
    } catch {
      return store.economy;
    }
    if (!Number.isFinite(body.capturedAt) || !Array.isArray(body.nations)) return store.economy;
    const economy: Economy = {
      capturedAt: body.capturedAt,
      nations: body.nations.map((nation) => ({ nation: nation.nation, cash: nation.cash, netWorth: nation.net_worth, players: nation.players })),
    };
    persist({ ...stored(), economy });
    return economy;
  });
}
