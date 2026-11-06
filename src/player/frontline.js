const key = (p) => `${p[0]},${p[1]}`;

function smooth(points, loop) {
  const count = points.length,
    result = [];
  for (let i = 0; i < count; i++) {
    const sum = [0, 0];
    for (let delta = -2; delta <= 2; delta++) {
      const index = loop
        ? (i + delta + count) % count
        : Math.max(0, Math.min(count - 1, i + delta));
      sum[0] += points[index][0] * 0.2;
      sum[1] += points[index][1] * 0.2;
    }
    result.push(sum);
  }
  if (loop) result.push([...result[0]]);
  else {
    result[0] = [...points[0]];
    result[count - 1] = [...points[count - 1]];
  }
  return result;
}

function pushout(points, positions, radius = 18) {
  if (!positions.length) return points;
  return points.map((point) => {
    let closest = null,
      distance2 = Infinity;
    for (const dot of positions) {
      const dx = point[0] - dot[0],
        dy = point[1] - dot[1],
        distance = dx * dx + dy * dy;
      if (distance < distance2) {
        distance2 = distance;
        closest = dot;
      }
    }
    if (distance2 >= radius * radius) return point;
    if (distance2 === 0) return [...closest];
    const scale = radius / Math.sqrt(distance2);
    return [
      closest[0] + (point[0] - closest[0]) * scale,
      closest[1] + (point[1] - closest[1]) * scale,
    ];
  });
}

export function frontLines(contours, dots, mapSize = [1600, 900]) {
  // The simulator also exports the supply polygons after the native endpoint
  // extension. Restore their contour endpoints before finding shared edges.
  contours = contours.map((side, color) =>
    side.map((polygon) => {
      const p = polygon.map((v) => [...v]),
        last = p.length - 1;
      if (
        color === 0 &&
        last > 1 &&
        key(p[0]) !== key(p[last]) &&
        p.every(
          (v) =>
            v[0] >= 0 && v[1] >= 0 && v[0] <= mapSize[0] && v[1] <= mapSize[1],
        )
      ) {
        p[0] = p[0].map((v, k) => (v + 0.5 * p[1][k]) / 1.5);
        p[last] = p[last].map((v, k) => (v + 0.5 * p[last - 1][k]) / 1.5);
      }
      return p;
    }),
  );
  const lines = [];
  const positions = contours.map((_, color) =>
    dots
      .filter((d) => d && d.health > 0 && !d.ship && d.color === color)
      .map((d) => d.position),
  );
  // As in the game, a side's polygon is matched against each of the other side's
  // polygons in turn. Points past the map's edge are shared by every polygon that
  // reaches that edge, so matching against all of them at once would join two
  // separate lines along the edge.
  const sets = contours.map((polygons) =>
    polygons.map((polygon) => new Set(polygon.map(key))),
  );
  const adjust = (points, loop, colors) => {
    if (points.length <= 2) return points.map((p) => [...p]);
    extend(points);
    let line = smooth(points, loop);
    for (const color of colors) line = pushout(line, positions[color]);
    return line;
  };
  for (let side = 0; side < contours.length; side++)
    for (let other = side + 1; other < contours.length; other++)
      contours[side].forEach((polygon, index) => {
        const own = sets[side][index];
        for (const set of sets[other]) {
          if (![...own].some((k) => set.has(k))) continue;
          const mask = polygon.map((p) => set.has(key(p)));
          if (mask.every(Boolean)) {
            lines.push(adjust(polygon, true, [side, other]));
            continue;
          }
          const n = mask.length,
            starts = [],
            ends = [];
          for (let i = 0; i < n; i++) {
            const change = mask[i] - mask[(i + n - 1) % n];
            if (change === 1) starts.push(i);
            else if (change === -1) ends.push(i);
          }
          if (!starts.length) continue;
          if (starts[0] >= ends[0]) {
            // A run that wraps past the polygon's start is a copy in the game.
            const run = [...polygon.slice(starts.at(-1)), ...polygon.slice(0, ends[0])];
            lines.push(adjust(run.map((p) => [...p]), false, [side, other]));
            starts.pop();
            ends.shift();
          }
          // Other runs share the polygon's points, so extending their ends
          // moves those points for the polygons matched after.
          starts.forEach((start, i) =>
            lines.push(adjust(polygon.slice(start, ends[i]), false, [side, other])),
          );
        }
      });
  return lines;
}

/// Lengthens a run by half its first and last steps, in place.
function extend(points) {
  const n = points.length;
  const at = (end, next, after) => {
    const from = points[end][0] === points[next][0] && points[end][1] === points[next][1] ? points[after] : points[next];
    points[end][0] = (points[end][0] - from[0]) * 1.5 + from[0];
    points[end][1] = (points[end][1] - from[1]) * 1.5 + from[1];
  };
  at(0, 1, 2);
  at(n - 1, n - 2, n - 3);
}
