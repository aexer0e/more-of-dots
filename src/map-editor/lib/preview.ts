// Previews of what the game makes of a map. Both follow the engine
// (engine/replay-sim): the starting territory is its influence grid
// (territory.rs), and shock units come from its experiment layout rule
// (deployments.rs, try_convert).
import type { MapData, Point } from './types';

/**
 * Experiment matches turn every fifth infantry of a team, counted back from the
 * last and never the first, into a shock unit. Returns the indexes that convert.
 */
export function shockIndexes(count: number): Set<number> {
  const indexes = new Set<number>();
  for (let index = count - 1; index >= 1; index -= 5) indexes.add(index);
  return indexes;
}

/**
 * Puts shock units listed apart (older More of Dots maps, experiment layouts)
 * back among the infantry, at the places the rule above takes them from.
 * Returns null when the counts do not fit the rule.
 */
export function mergeShocks(infantry: Point[], shocks: Point[]): Point[] | null {
  const total = infantry.length + shocks.length;
  const merged: Array<Point | null> = Array.from({ length: total }, () => null);
  for (let index = 0; index < shocks.length; index += 1) {
    const at = total - 1 - 5 * index;
    if (at < 1) return null;
    merged[at] = shocks[index];
  }
  let next = 0;
  for (let slot = 0; slot < total; slot += 1) {
    if (!merged[slot]) merged[slot] = infantry[next++];
  }
  return merged as Point[];
}

const DOT_RADIUS = 12;
const CITY_RADIUS = 90;

function kernel(radius: number, power: number, strength: number) {
  const size = 2 * radius + 1;
  const values = new Float32Array(size * size);
  for (let x = -radius; x <= radius; x += 1) {
    for (let y = -radius; y <= radius; y += 1) {
      values[(x + radius) * size + (y + radius)] = strength / (1 + (x * x + y * y) ** power);
    }
  }
  return values;
}

const DOT_KERNEL = kernel(DOT_RADIUS, 3, 5);
const CITY_KERNEL = kernel(CITY_RADIUS, 2, 1);

function add(grid: Float32Array, width: number, height: number, cx: number, cy: number, values: Float32Array, radius: number) {
  const size = 2 * radius + 1;
  const left = Math.max(0, cx - radius);
  const right = Math.min(width - 1, cx + radius);
  const top = Math.max(0, cy - radius);
  const bottom = Math.min(height - 1, cy + radius);
  for (let x = left; x <= right; x += 1) {
    const row = (x - cx + radius) * size;
    const column = x * height;
    for (let y = top; y <= bottom; y += 1) {
      grid[column + y] += values[row + (y - cy + radius)];
    }
  }
}

export interface TerritoryPreview {
  /** Cells of 10 game units, x-major: `owners[x * height + y]` is a team index. */
  owners: Uint8Array;
  width: number;
  height: number;
  /** Game units per editor pixel. */
  scale: number;
  cityOwners: number[];
}

/**
 * The territory when a classic match starts. `scale` converts editor pixels to
 * the game's units (5/3 for a 960 × 540 map, which the game plays at 1600 × 900).
 * The engine updates territory every tick and recolors cities from it, so the
 * grid is recomputed until the city colors settle, as the first ticks would.
 */
export function startingTerritory(data: MapData, teams: number, editorWidth: number, scale: number): TerritoryPreview | null {
  const gameWidth = editorWidth === 960 ? 1600 : 1920;
  const gameHeight = editorWidth === 960 ? 900 : 1080;
  const width = Math.floor(gameWidth / 10);
  const height = Math.floor(gameHeight / 10);
  // Units in the engine's order: each team's infantry, then its tanks.
  const units: Array<{ owner: number; x: number; y: number }> = [];
  for (let team = 0; team < teams; team += 1) {
    for (const [x, y] of [...(data.infantry[team] ?? []), ...(data.tanks[team] ?? [])]) {
      units.push({ owner: team, x: Math.round(x * scale), y: Math.round(y * scale) });
    }
  }
  if (!units.length) return null;
  const cities = data.cities.map(([x, y]) => ({ x: Math.round(x * scale), y: Math.round(y * scale) }));
  let cityOwners = cities.map((city) => {
    let best = units[0];
    for (const unit of units.slice(1)) {
      if ((unit.x - city.x) ** 2 + (unit.y - city.y) ** 2 < (best.x - city.x) ** 2 + (best.y - city.y) ** 2) best = unit;
    }
    return best.owner;
  });

  const cell = (value: number) => Math.trunc(value / 10);
  let owners: Uint8Array | null = null;
  for (let pass = 0; pass < 8; pass += 1) {
    const influence = Array.from({ length: teams }, () => new Float32Array(width * height));
    for (const unit of units) add(influence[unit.owner], width, height, cell(unit.x), cell(unit.y), DOT_KERNEL, DOT_RADIUS);
    cities.forEach((city, index) => add(influence[cityOwners[index]], width, height, cell(city.x), cell(city.y), CITY_KERNEL, CITY_RADIUS));
    const next = new Uint8Array(width * height);
    for (let i = 0; i < next.length; i += 1) {
      let max = influence[0][i];
      let owner = 0;
      for (let team = 1; team < teams; team += 1) {
        if (influence[team][i] >= max) {
          max = influence[team][i];
          owner = team;
        }
      }
      // A cell no team reaches keeps the owner it had.
      next[i] = owners && owner !== owners[i] && max < 1e-5 ? owners[i] : owner;
    }
    owners = next;
    const recolored = cities.map((city) => {
      const x = Math.min(width - 1, Math.max(0, cell(city.x)));
      const y = Math.min(height - 1, Math.max(0, cell(city.y)));
      return next[x * height + y];
    });
    const settled = recolored.every((owner, index) => owner === cityOwners[index]);
    cityOwners = recolored;
    if (settled) break;
  }
  return { owners: owners!, width, height, scale, cityOwners };
}
