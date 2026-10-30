// The troop lines drawn on replay cards: each side's troops over the whole match.

export type TroopSides = number[][];

const SIZE = 1000;

/** Reads the host's store: one `{"h":hash,"s":sides}` per line. A damaged line is skipped. */
export function parseTroopStore(text: string): Map<string, TroopSides> {
  const lines = new Map<string, TroopSides>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const { h, s } = JSON.parse(line);
      if (typeof h === "string" && Array.isArray(s)) lines.set(h, s);
    } catch {
      // Only the line being written when the app closed can be damaged.
    }
  }
  return lines;
}

// A smooth curve through the points, as whole numbers to keep the markup short.
function curve(points: [number, number][]): string {
  let path = `M${points[0][0]} ${points[0][1]}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const before = points[Math.max(index - 1, 0)];
    const start = points[index];
    const end = points[index + 1];
    const after = points[Math.min(index + 2, points.length - 1)];
    path += `C${Math.round(start[0] + (end[0] - before[0]) / 6)} ${Math.round(start[1] + (end[1] - before[1]) / 6)} ${Math.round(end[0] - (after[0] - start[0]) / 6)} ${Math.round(end[1] - (after[1] - start[1]) / 6)} ${end[0]} ${end[1]}`;
  }
  return path;
}

/** Averages a side's troops into at most `points` evenly spaced values. */
export function reduceTroops(values: number[], points = 30): number[] {
  const count = Math.min(points, values.length);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * values.length) / count);
    const end = Math.max(Math.floor(((index + 1) * values.length) / count), start + 1);
    let total = 0;
    for (let at = start; at < end; at += 1) total += values[at];
    return Math.floor(total / (end - start));
  });
}

/** A curve per side for a picture of this size, scaled so the largest army reaches near the top. A wiped-out side's line stops there. Empty for a side with too few points. */
export function troopCurves(sides: TroopSides, width: number, height: number): string[] {
  const peak = Math.max(0, ...sides.flat());
  if (!peak) return [];
  const margin = height * 0.03;
  return sides.map((values) => {
    if (values.length < 2) return "";
    const wiped = values.indexOf(0);
    const kept = wiped > 0 ? values.slice(0, wiped + 1) : values;
    return curve(kept.map((value, index): [number, number] => [
      Math.round((index / (values.length - 1)) * width),
      Math.round(height - margin - (value / peak) * (height - 2 * margin)),
    ]));
  });
}

/** One thin line per side, stretched over the whole card. */
export function troopLinesMarkup(sides: TroopSides): string {
  const paths = troopCurves(sides, SIZE, SIZE)
    .map((path, side) => (path ? `<path class="replay-troop-line troop-side-${side + 1}" d="${path}"/>` : ""))
    .join("");
  return paths ? `<svg viewBox="0 0 ${SIZE} ${SIZE}" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>` : "";
}
