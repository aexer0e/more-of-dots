// The order rules of src/play/orders.js, which follow the orders recorded in the
// game's 1.4.1 replays.
import assert from "node:assert/strict";
import test from "node:test";
import { assign, clickOrders, extendGesture, gatherOrders, formationOrders, inside, isLoop, routeOrders, spread, stopOrders } from "../src/play/orders.js";

test("a drawn route gains a waypoint every 24 pixels", () => {
  const gesture = [[0, 0]];
  for (let x = 1; x <= 100; x++) extendGesture(gesture, [x, 0]);
  assert.deepEqual(gesture, [[0, 0], [24, 0], [48, 0], [72, 0], [96, 0]]);
});

test("a group follows a route moved by each unit's offset from the drag's start", () => {
  const orders = routeOrders(
    [
      { id: 3, position: [100.6, 200.2] },
      { id: 4, position: [130, 210] },
    ],
    [[100, 200], [100, 245], [140, 280]],
  );
  assert.deepEqual(orders.get(3), [[100, 200], [100, 245], [140, 280]]);
  assert.deepEqual(orders.get(4), [[130, 210], [130, 255], [170, 290]]);
});

test("a click moves a group by the click's offset from its centre", () => {
  const orders = clickOrders(
    [
      { id: 1, position: [300, 440] },
      { id: 2, position: [270, 474] },
    ],
    [316, 440],
  );
  assert.deepEqual(orders.get(1), [[300, 440], [331, 423]]);
  assert.deepEqual(orders.get(2), [[270, 474], [301, 457]]);
});

test("Alt+click gathers every selected unit on the clicked point", () => {
  const orders = gatherOrders(
    [
      { id: 1, position: [300, 440] },
      { id: 2, position: [270, 474] },
    ],
    [316.7, 440.2],
  );
  assert.deepEqual(orders.get(1), [[300, 440], [316, 440]]);
  assert.deepEqual(orders.get(2), [[270, 474], [316, 440]]);
});

test("a formation spreads units evenly along the line, ends included", () => {
  assert.deepEqual(spread([[0, 0], [90, 0]], 4), [[0, 0], [30, 0], [60, 0], [90, 0]]);
  assert.deepEqual(spread([[0, 0], [50, 0], [50, 50]], 3), [[0, 0], [50, 0], [50, 50]]);
  assert.deepEqual(spread([[0, 0], [10, 0]], 1), [[5, 0]]);
});

test("formation slots go to units by the smallest total distance", () => {
  const units = [
    { id: 13, position: [450, 323] },
    { id: 14, position: [1067, 556] },
    { id: 15, position: [517, 373] },
    { id: 16, position: [890, 471] },
  ];
  const orders = formationOrders(units, [[631, 350], [831, 350]]);
  assert.deepEqual([...orders].map(([id, path]) => [id, path[1]]), [
    [13, [631, 350]],
    [14, [831, 350]],
    [15, [697, 350]],
    [16, [764, 350]],
  ]);
});

test("the assignment is optimal", () => {
  const permutations = (items) => (items.length < 2 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 100;
  for (let round = 0; round < 50; round++) {
    const n = 1 + (round % 6),
      cost = Array.from({ length: n }, () => Array.from({ length: n }, random)),
      total = (columns) => columns.reduce((sum, column, row) => sum + cost[row][column], 0),
      best = Math.min(...permutations([...Array(n).keys()]).map(total));
    assert.ok(Math.abs(total(assign(cost)) - best) < 1e-9);
  }
});

test("stopping sends an empty order", () => {
  assert.deepEqual([...stopOrders([{ id: 5, position: [1, 2] }])], [[5, []]]);
});

test("a loop that comes back to its start selects what it surrounds", () => {
  const circle = Array.from({ length: 41 }, (_, k) => [100 + 50 * Math.cos((k / 40) * 2 * Math.PI), 100 + 50 * Math.sin((k / 40) * 2 * Math.PI)]);
  assert.ok(isLoop(circle));
  assert.ok(inside([100, 100], circle));
  assert.ok(!inside([200, 100], circle));
  assert.ok(!isLoop([[0, 0], [50, 0], [100, 0], [150, 0]]));
});
