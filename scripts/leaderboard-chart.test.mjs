import assert from 'node:assert/strict';
import test from 'node:test';
import { chartAxis, playerColors, seriesPath, snapshotDelay, MAX_COMPARISONS } from '../src/leaderboard/chart.ts';

test('chart ticks use uniform round intervals and cover the data', () => {
  for (const values of [[2267, 2283, 2298], [1451, 3699], [-51, 13], [2300, 2300], [1, 2, 3]]) {
    const { low, high, step, ticks } = chartAxis(values);
    assert.ok(low <= Math.min(...values) && high >= Math.max(...values));
    assert.ok(high > low);
    assert.ok([1, 2, 5, 10].includes(step / 10 ** Math.floor(Math.log10(step))));
    for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i] - ticks[i - 1], step);
  }
  assert.deepEqual(chartAxis([2267, 2298]).ticks, [2260, 2270, 2280, 2290, 2300]);
  assert.ok(chartAxis([1, 9], true).low >= 0);
});

test('missing observations and long capture gaps are connected without changing the data', () => {
  const points = [{ stamp: 10, value: 20 }, { stamp: 20, value: null }, { stamp: 500, value: 40 }];
  assert.equal(seriesPath(points, (x) => x, (y) => y), 'M10,20 L500,40');
  assert.equal(points[1].value, null);
  assert.equal(seriesPath([{ stamp: 10, value: null }], (x) => x, (y) => y), '');
});

test('ten comparisons plus the current player get distinct stable colors', () => {
  const names = ['me', ...Array.from({ length: MAX_COMPARISONS }, (_, i) => `player${i}`)];
  const colors = playerColors(names, new Map());
  assert.equal(colors.size, 11);
  assert.equal(new Set(colors.values()).size, 11);
  const next = playerColors([...names.slice(1), 'new'], colors);
  for (const name of names.slice(1)) assert.equal(next.get(name), colors.get(name));
  assert.equal(new Set(next.values()).size, 11);
});

test('snapshot warning starts only after one hour and reports its age', () => {
  const capturedAt = 10000;
  assert.equal(snapshotDelay(capturedAt, (capturedAt + 3599) * 1000), null);
  assert.equal(snapshotDelay(capturedAt, (capturedAt + 3600) * 1000), null);
  assert.equal(snapshotDelay(capturedAt, (capturedAt + 3601) * 1000), '1h 0m ago');
  assert.equal(snapshotDelay(capturedAt, (capturedAt + 4500) * 1000), '1h 15m ago');
});
