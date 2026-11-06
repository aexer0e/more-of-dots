// Pure helpers for the Nations tab: compact history rows, range selection and
// the capture-aligned refresh schedule. No network or storage access here.

export const CAPTURE_SECONDS = 1800;
/** Captures take a little while to land, so the check waits past the capture time. */
export const CHECK_DELAY_SECONDS = 60;
/** A capture that is late is retried at this interval, never faster. */
export const RETRY_SECONDS = 300;
/** Full 30-minute resolution is kept for this long; older history keeps one row per day. */
export const RECENT_SECONDS = 7 * 86400;
export const DAY_SECONDS = 86400;

export type Range = '24h' | '1w' | '30d' | 'all';
export const RANGES: { id: Range; label: string; seconds: number | null; daily: boolean }[] = [
  { id: '24h', label: '24H', seconds: DAY_SECONDS, daily: false },
  { id: '1w', label: '1W', seconds: 7 * DAY_SECONDS, daily: false },
  { id: '30d', label: '30D', seconds: 30 * DAY_SECONDS, daily: true },
  { id: 'all', label: 'All', seconds: null, daily: true },
];

/** One capture, reduced to what the tab draws. */
export type Row = { t: number; id: number; hash: string; rp: number; bp: number; rc: number; bc: number };

/** The fields of an API snapshot row that the tab reads. */
export type ApiRow = {
  id: number; capturedAt: number; mapHash: string; width: number; height: number;
  encoding: string; playablePixels: number | null; mapUrl: string;
  redPixels: number | null; bluePixels: number | null; redCities: number | null; blueCities: number | null;
};

export type Latest = Pick<ApiRow, 'id' | 'capturedAt' | 'mapHash' | 'width' | 'height' | 'encoding' | 'playablePixels' | 'mapUrl'>;

export function compactRow(row: ApiRow): Row | null {
  const values = [row.redPixels, row.bluePixels, row.redCities, row.blueCities];
  if (!Number.isFinite(row.capturedAt) || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null;
  return { t: row.capturedAt, id: row.id, hash: row.mapHash, rp: row.redPixels!, bp: row.bluePixels!, rc: row.redCities!, bc: row.blueCities! };
}

export function latestOf(row: ApiRow): Latest {
  const { id, capturedAt, mapHash, width, height, encoding, playablePixels, mapUrl } = row;
  return { id, capturedAt, mapHash, width, height, encoding, playablePixels, mapUrl };
}

export function mergeRows(...lists: Row[][]): Row[] {
  const byTime = new Map<number, Row>();
  for (const list of lists) for (const row of list) byTime.set(row.t, row);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** Keeps the last capture of each UTC day. */
export function dailyRows(rows: Row[]): Row[] {
  const byDay = new Map<number, Row>();
  for (const row of rows) {
    const day = Math.floor(row.t / DAY_SECONDS);
    const kept = byDay.get(day);
    if (!kept || kept.t < row.t) byDay.set(day, row);
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

/** Moves rows older than the recent window into the one-per-day store. */
export function settle(recent: Row[], daily: Row[], latest: number): { recent: Row[]; daily: Row[] } {
  const cutoff = latest - RECENT_SECONDS - DAY_SECONDS;
  const keep = recent.filter((row) => row.t >= cutoff);
  const aged = recent.filter((row) => row.t < cutoff);
  return { recent: keep, daily: dailyRows(mergeRows(daily, aged)) };
}

/** Rows for a chart range. Ranges longer than a week use one capture per day. */
export function rangeRows(recent: Row[], daily: Row[], range: Range): Row[] {
  const spec = RANGES.find((entry) => entry.id === range) ?? RANGES[1];
  const end = Math.max(recent.at(-1)?.t ?? 0, daily.at(-1)?.t ?? 0);
  const from = spec.seconds == null ? -Infinity : end - spec.seconds;
  const source = spec.daily ? dailyRows(mergeRows(daily, recent)) : recent;
  return source.filter((row) => row.t >= from);
}

/** The earliest timestamp a range needs, or null when only stored rows are needed. */
export function rangeStart(range: Range, latest: number, oldest: number | null): number | null {
  const spec = RANGES.find((entry) => entry.id === range);
  if (!spec || !spec.daily) return null;
  return spec.seconds == null ? (oldest ?? 0) : latest - spec.seconds;
}

export type Shares = { land: number; cities: number };
/** Blue's share of land and cities, in percent. Up on the chart is Blue. */
export function blueShare(row: Row): Shares {
  const land = row.rp + row.bp, cities = row.rc + row.bc;
  return { land: land ? row.bp / land * 100 : 50, cities: cities ? row.bc / cities * 100 : 50 };
}

/**
 * Milliseconds until the next useful request. Captures land every 30 minutes, so the
 * next check waits for the one after `latest`; a capture that has not appeared yet is
 * retried every few minutes instead of on every timer tick.
 */
export function nextCheckDelay(latest: number | null, lastAttemptMs: number, nowMs: number): number {
  if (latest == null) return Math.max(0, lastAttemptMs + RETRY_SECONDS * 1000 - nowMs);
  const due = (latest + CAPTURE_SECONDS + CHECK_DELAY_SECONDS) * 1000;
  const retry = lastAttemptMs + RETRY_SECONDS * 1000;
  return Math.max(0, Math.max(due, retry) - nowMs);
}

export const SLOPE_COLORS = { blue: [96, 140, 232], red: [226, 92, 92], neutral: [138, 130, 152] } as const;
export type SlopeStop = { offset: number; color: string };
/**
 * Gradient stops that colour a line by its local direction, like the website's
 * Movement chart: blue where Blue is gaining, red where Red is, grey where flat.
 * Faster movement gives a stronger colour. `values` are Blue's share at each time.
 */
export function slopeStops(times: number[], values: number[]): SlopeStop[] {
  const count = Math.min(times.length, values.length);
  if (count < 2) return [];
  const first = times[0], span = Math.max(1, times[count - 1] - first);
  const slopes = Array.from({ length: count }, (_, index) => {
    const before = Math.max(0, index - 1), after = Math.min(count - 1, index + 1);
    const hours = Math.max(1 / 60, (times[after] - times[before]) / 3600);
    return (values[after] - values[before]) / hours;
  });
  const largest = Math.max(0, ...slopes.map(Math.abs));
  return slopes.map((slope, index) => {
    const flat = Math.abs(slope) < 1e-9;
    const strength = flat || largest === 0 ? 0 : 0.68 + Math.sqrt(Math.abs(slope) / largest) * 0.32;
    const target = slope > 0 ? SLOPE_COLORS.blue : SLOPE_COLORS.red;
    const color = SLOPE_COLORS.neutral.map((channel, channelIndex) => Math.round(channel + (target[channelIndex] - channel) * strength));
    return { offset: (times[index] - first) / span, color: `rgb(${color.join(', ')})` };
  });
}

export type Axis ={ low: number; high: number; ticks: number[]; decimals: number };
const TICK_STEPS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20];
/**
 * A percentage axis fitted to the data, like the website's Movement chart: small
 * movements fill the chart instead of sitting flat beside a distant 50% line.
 */
export function shareAxis(values: number[]): Axis {
  const finite = values.filter(Number.isFinite);
  let low = finite.length ? Math.min(...finite) : 49.5;
  let high = finite.length ? Math.max(...finite) : 50.5;
  const span = Math.max(0.12, high - low);
  const middle = (low + high) / 2;
  low = Math.max(0, middle - span / 2 - span * 0.18);
  high = Math.min(100, middle + span / 2 + span * 0.18);
  const step = TICK_STEPS.find((candidate) => (high - low) / candidate <= 7) ?? 20;
  const ticks: number[] = [];
  for (let value = Math.ceil(low / step) * step; value <= high + 1e-9; value += step) ticks.push(Number(value.toFixed(4)));
  return { low, high, ticks, decimals: (String(step).split('.')[1] ?? '').length };
}
