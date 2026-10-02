export const PLAYER_COLORS = ['#7cb9f1', '#f2b85f', '#b59af5', '#63d4a1', '#f27894', '#59d3e5', '#e7db70', '#e49fea', '#f19464', '#a8cf75', '#dce8f1'];
export const MAX_COMPARISONS = 10;

export function playerColors(names: string[], previous: Map<string, string>) {
  const colors = new Map(names.filter((name) => previous.has(name)).map((name) => [name, previous.get(name)!]));
  const used = new Set(colors.values());
  for (const name of names) {
    if (colors.has(name)) continue;
    const color = PLAYER_COLORS.find((candidate) => !used.has(candidate))!;
    colors.set(name, color); used.add(color);
  }
  return colors;
}

export function chartAxis(values: number[], rank = false) {
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || Math.max(4, Math.abs(max) * .02);
  const roughStep = range / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const step = Math.max(1, ([1, 2, 5, 10].find((factor) => factor * magnitude >= roughStep) ?? 10) * magnitude);
  let low = Math.floor(min / step) * step, high = Math.ceil(max / step) * step;
  if (low === high) { low -= step; high += step; }
  if (rank) low = Math.max(0, low);
  const ticks = Array.from({ length: Math.round((high - low) / step) + 1 }, (_, i) => low + i * step);
  return { low, high, step, ticks };
}

export function changedSeries(points: { stamp: number; value: number | null }[]) {
  return points.filter((point, index) => index === 0 || point.value !== points[index - 1].value);
}

export function seriesValueAt(points: { stamp: number; value: number | null }[], stamp: number) {
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    if (point.stamp <= stamp && point.value != null && Number.isFinite(point.value)) return point.value;
  }
  return null;
}

export function seriesPath(points: { stamp: number; value: number | null }[], x: (stamp: number) => number, y: (value: number) => number, to?: number) {
  const observed = changedSeries(points).filter((p): p is { stamp: number; value: number } => p.value != null && Number.isFinite(p.value));
  if (!observed.length) return '';
  let path = `M${x(observed[0].stamp)},${y(observed[0].value)}`;
  for (let index = 1; index < observed.length; index++) {
    const previous = observed[index - 1], current = observed[index];
    path += ` L${x(current.stamp)},${y(previous.value)} L${x(current.stamp)},${y(current.value)}`;
  }
  const last = observed.at(-1)!;
  if (to != null && to > last.stamp) path += ` L${x(to)},${y(last.value)}`;
  return path;
}

export function nearestSeriesName(series: { name: string; value: number | null }[], pointerY: number, y: (value: number) => number) {
  let nearest: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const point of series) {
    if (point.value == null || !Number.isFinite(point.value)) continue;
    const distance = Math.abs(y(point.value) - pointerY);
    if (distance < nearestDistance) {
      nearest = point.name;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function snapshotDelay(capturedAt: number, now = Date.now()) {
  const age = Math.max(0, Math.floor(now / 1000 - capturedAt));
  if (age <= 3600) return null;
  const minutes = Math.floor(age / 60), hours = Math.floor(minutes / 60);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h ago` : `${hours}h ${minutes % 60}m ago`;
}

export function historyTimeAgo(capturedAt: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor(now / 1000 - capturedAt));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
