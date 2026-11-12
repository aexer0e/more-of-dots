// The engine's contour extraction (engine/replay-sim/src/contours.rs) in
// JavaScript: binary marching squares over one side's territory cells, with the
// same segment assembly, edge simplification and endpoint extension, so the
// replay player's front lines come out as they do in replays.

export function extract(regions, side, width, height) {
  const chains = [];
  const starts = new Map();
  const ends = new Map();
  const key = (p) => p[0] * 100000 + p[1];
  const take = (table, k) => {
    const value = table.get(k);
    table.delete(k);
    return value;
  };
  const segment = (from, to) => {
    const fk = key(from), tk = key(to);
    const tail = take(starts, tk);
    const head = take(ends, fk);
    if (head === undefined && tail === undefined) {
      const id = chains.length;
      chains.push({ id, points: [from, to] });
      starts.set(fk, id);
      ends.set(tk, id);
    } else if (head === undefined) {
      chains[tail].points.unshift(from);
      starts.set(fk, tail);
    } else if (tail === undefined) {
      chains[head].points.push(to);
      ends.set(tk, head);
    } else if (head === tail) {
      chains[head].points.push(to);
    } else if (chains[tail].id > chains[head].id) {
      const moved = chains[tail];
      chains[tail] = null;
      const chain = chains[head];
      chain.points.push(...moved.points);
      starts.set(key(chain.points[0]), head);
      ends.set(key(chain.points.at(-1)), head);
    } else {
      const moved = chains[head];
      chains[head] = null;
      starts.delete(key(moved.points[0]));
      const chain = chains[tail];
      chain.points.unshift(...moved.points);
      starts.set(key(chain.points[0]), tail);
      ends.set(key(chain.points.at(-1)), tail);
    }
  };

  // The side's cells with an empty border, x-major like the grid.
  const stride = height + 2;
  const mask = new Uint8Array((width + 2) * stride);
  const occupied = new Array(width + 2).fill(false);
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++)
      if (regions[x * height + y] === side) {
        mask[(x + 1) * stride + 1 + y] = 1;
        occupied[x + 1] = true;
      }
  for (let x = 0; x < width + 1; x++) {
    if (!occupied[x] && !occupied[x + 1]) continue;
    const left = x * stride, right = (x + 1) * stride;
    for (let y = 0; y < height + 1; y++) {
      const code = mask[left + y] | (mask[left + y + 1] << 1) | (mask[right + y] << 2) | (mask[right + y + 1] << 3);
      if (code === 0 || code === 15) continue;
      const x2 = 2 * x, y2 = 2 * y;
      const top = [x2, y2 + 1], bottom = [x2 + 2, y2 + 1], l = [x2 + 1, y2], r = [x2 + 1, y2 + 2];
      switch (code) {
        case 1: segment(top, l); break;
        case 2: segment(r, top); break;
        case 3: segment(r, l); break;
        case 4: segment(l, bottom); break;
        case 5: segment(top, bottom); break;
        case 6: segment(r, top); segment(l, bottom); break;
        case 7: segment(r, bottom); break;
        case 8: segment(bottom, r); break;
        case 9: segment(top, l); segment(bottom, r); break;
        case 10: segment(bottom, top); break;
        case 11: segment(bottom, l); break;
        case 12: segment(l, r); break;
        case 13: segment(top, r); break;
        case 14: segment(l, top); break;
      }
    }
  }
  const polygons = chains.filter(Boolean).map((chain) => simplify(chain.points.map(([px, py]) => [px / 2, py / 2]), width, height));
  if (side === 0)
    for (const polygon of polygons) {
      const n = polygon.length;
      if (n > 2 && !polygon.some(([px, py]) => px === -10 || px === (width + 1) * 10 || py === -10 || py === (height + 1) * 10)) {
        polygon[0] = [(polygon[0][0] - polygon[1][0]) * 1.5 + polygon[1][0], (polygon[0][1] - polygon[1][1]) * 1.5 + polygon[1][1]];
        polygon[n - 1] = [(polygon[n - 1][0] - polygon[n - 2][0]) * 1.5 + polygon[n - 2][0], (polygon[n - 1][1] - polygon[n - 2][1]) * 1.5 + polygon[n - 2][1]];
      }
    }
  return polygons;
}

function simplify(source, width, height) {
  const w = width, h = height, n = source.length;
  const points = [], boundary = [], corners = [];
  for (const [sx, sy] of source) {
    const px = sx - 0.5, py = sy - 0.5;
    const xEdge = px <= 0.5 || px >= w - 0.5, yEdge = py <= 0.5 || py >= h - 0.5;
    points.push([px <= 0.5 ? -1 : px >= w - 0.5 ? w + 1 : px, py <= 0.5 ? -1 : py >= h - 0.5 ? h + 1 : py]);
    boundary.push(xEdge || yEdge);
    corners.push(xEdge && yEdge);
  }
  const result = [];
  for (let i = 0; i < n; i++)
    if (corners[i] || !(boundary[i] && boundary[(i + n - 1) % n] && boundary[(i + 1) % n])) result.push([points[i][0] * 10, points[i][1] * 10]);
  return result;
}
