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

export function seriesPath(points: { stamp: number; value: number | null }[], x: (stamp: number) => number, y: (value: number) => number) {
  // Keep actual observations intact and connect across missing observations.
  return points.filter((p) => p.value != null && Number.isFinite(p.value))
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.stamp)},${y(p.value!)}`).join(' ');
}

export function snapshotDelay(capturedAt: number, now = Date.now()) {
  const age = Math.max(0, Math.floor(now / 1000 - capturedAt));
  if (age <= 3600) return null;
  const minutes = Math.floor(age / 60), hours = Math.floor(minutes / 60);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h ago` : `${hours}h ${minutes % 60}m ago`;
}
