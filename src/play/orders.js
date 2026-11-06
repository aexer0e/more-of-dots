// How the game turns mouse gestures into orders. The game's own interface code was
// not available; these rules are read from the orders recorded in 1.4.1 replays
// (the published tournament replays):
// - An order is the unit's position followed by its waypoints, in whole pixels.
//   An empty order stops the unit.
// - A drawn route gains a waypoint each time the pointer is 24 pixels from the
//   previous one. Every selected unit follows the route moved by its own offset
//   from the point where the drag began, so a group keeps its shape.
// - A click sends each selected unit by the click's offset from the group's
//   centre, so the group keeps its shape there too.
// - Alt+click sends every selected unit to the clicked point.
// - A formation (Ctrl-drag) spreads the units evenly along the drawn line, ends
//   included, and gives each slot to a unit so that the total distance the units
//   walk is as small as possible.

export const WAYPOINT_SPACING = 24;
// A unit is under the pointer within this distance of its centre.
export const PICK_RADIUS = 15;

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const whole = (point) => [Math.trunc(point[0]), Math.trunc(point[1])];

/** Adds the pointer's position to a gesture when it is far enough from the last waypoint. */
export function extendGesture(gesture, point) {
  if (distance(gesture.at(-1), point) >= WAYPOINT_SPACING) gesture.push(point);
}

/** Orders for units following a drawn route; `route[0]` is where the drag began. */
export function routeOrders(units, route) {
  const orders = new Map();
  const [ox, oy] = route[0];
  for (const unit of units) {
    const [ux, uy] = unit.position;
    orders.set(unit.id, [whole(unit.position), ...route.slice(1).map(([x, y]) => whole([x + ux - ox, y + uy - oy]))]);
  }
  return orders;
}

/** Orders for units sent to a clicked point, keeping the group's shape. */
export function clickOrders(units, target) {
  const orders = new Map();
  if (!units.length) return orders;
  const cx = units.reduce((sum, unit) => sum + unit.position[0], 0) / units.length,
    cy = units.reduce((sum, unit) => sum + unit.position[1], 0) / units.length;
  for (const unit of units)
    orders.set(unit.id, [whole(unit.position), whole([target[0] + unit.position[0] - cx, target[1] + unit.position[1] - cy])]);
  return orders;
}

/** Orders that gather units on one point (Alt+click). */
export function gatherOrders(units, target) {
  return new Map(units.map((unit) => [unit.id, [whole(unit.position), whole(target)]]));
}

/** `count` points spread evenly along a polyline by length, ends included. */
export function spread(line, count) {
  if (!count || !line.length) return [];
  if (line.length === 1) return Array.from({ length: count }, () => [...line[0]]);
  const lengths = [0];
  for (let i = 1; i < line.length; i++) lengths.push(lengths[i - 1] + distance(line[i - 1], line[i]));
  const total = lengths.at(-1);
  return Array.from({ length: count }, (_, n) => {
    const at = count === 1 ? total / 2 : (total * n) / (count - 1);
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < at) i++;
    const span = lengths[i] - lengths[i - 1],
      t = span ? (at - lengths[i - 1]) / span : 0;
    return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
  });
}

/** The assignment of rows to columns with the smallest total cost (Hungarian method). */
export function assign(cost) {
  const n = cost.length,
    u = new Float64Array(n + 1),
    v = new Float64Array(n + 1),
    p = new Int32Array(n + 1),
    way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity),
      used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity,
        j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (current < minv[j]) (minv[j] = current), (way[j] = j0);
        if (minv[j] < delta) (delta = minv[j]), (j1 = j);
      }
      for (let j = 0; j <= n; j++)
        if (used[j]) (u[p[j]] += delta), (v[j] -= delta);
        else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const columns = new Array(n);
  for (let j = 1; j <= n; j++) if (p[j]) columns[p[j] - 1] = j - 1;
  return columns;
}

/** Orders for units spread along a formation line. */
export function formationOrders(units, line) {
  const orders = new Map(),
    slots = spread(line, units.length);
  if (!slots.length) return orders;
  const columns = assign(units.map((unit) => slots.map((slot) => distance(unit.position, slot))));
  units.forEach((unit, row) => orders.set(unit.id, [whole(unit.position), whole(slots[columns[row]])]));
  return orders;
}

/** Orders that stop units where they stand. */
export function stopOrders(units) {
  return new Map(units.map((unit) => [unit.id, []]));
}

/** Whether a point lies inside a closed polygon (even-odd rule). */
export function inside(point, polygon) {
  let crossing = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) crossing = !crossing;
  }
  return crossing;
}

/** Whether a drawn gesture closes into a loop: its end comes back near its start. */
export function isLoop(points) {
  if (points.length < 3) return false;
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
  return length > 60 && distance(points[0], points.at(-1)) < Math.max(48, length * 0.25);
}
