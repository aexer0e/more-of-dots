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
    if (distance2 === 0) return [closest[0] + radius, closest[1]];
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
  const sets = contours.map((polygons) => new Set(polygons.flat().map(key)));
  for (let side = 0; side < contours.length; side++)
    for (let other = side + 1; other < contours.length; other++) {
      for (const polygon of contours[side]) {
        const mask = polygon.map((p) => sets[other].has(key(p)));
        const segments = [];
        if (mask.every(Boolean))
          segments.push({ points: polygon.map((p) => [...p]), loop: true });
        else {
          for (let i = 0; i < mask.length; i++) {
            if (!mask[i] || mask[(i + mask.length - 1) % mask.length]) continue;
            const points = [];
            let j = i;
            do {
              points.push([...polygon[j]]);
              j = (j + 1) % mask.length;
            } while (mask[j] && j !== i);
            if (points.length > 1) segments.push({ points, loop: false });
          }
        }
        for (const segment of segments) {
          const p = segment.points;
          p[0] = p[0].map((v, k) => (v - p[1][k]) * 1.5 + p[1][k]);
          const last = p.length - 1;
          p[last] = p[last].map(
            (v, k) => (v - p[last - 1][k]) * 1.5 + p[last - 1][k],
          );
          let line = smooth(p, segment.loop);
          for (const color of [side, other])
            line = pushout(line, positions[color]);
          lines.push(line);
        }
      }
    }
  return lines;
}
