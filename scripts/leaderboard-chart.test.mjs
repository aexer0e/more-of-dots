import assert from 'node:assert/strict';
import test from 'node:test';
import { changedSeries, chartAxis, historyTimeAgo, nearestSeriesName, playerColors, seriesPath, seriesValueAt, snapshotDelay, MAX_COMPARISONS } from '../src/leaderboard/chart.ts';

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
  assert.equal(seriesPath(points, (x) => x, (y) => y), 'M10,20 L500,20 L500,40');
  assert.equal(points[1].value, null);
  assert.equal(seriesPath([{ stamp: 10, value: null }], (x) => x, (y) => y), '');
});

test('series retain every change and discard repeated values', () => {
  const points = [{ stamp: 10, value: 20 }, { stamp: 20, value: 20 }, { stamp: 30, value: 21 }, { stamp: 40, value: 22 }];
  assert.deepEqual(changedSeries(points), [points[0], points[2], points[3]]);
  assert.equal(seriesPath(points, (x) => x, (y) => y, 50), 'M10,20 L30,20 L30,21 L40,21 L40,22 L50,22');
});

test('chart hover picks the line nearest to the pointer and ignores missing values', () => {
  const series = [{ name: 'blue', value: 100 }, { name: 'missing', value: null }, { name: 'orange', value: 140 }];
  assert.equal(nearestSeriesName(series, 136, (value) => value), 'orange');
  assert.equal(nearestSeriesName(series, 104, (value) => value), 'blue');
  assert.equal(nearestSeriesName([{ name: 'missing', value: null }], 100, (value) => value), null);
});

test('hover follows horizontal steps without selecting a future checkpoint', () => {
  const points = [{ stamp: 10, value: 20 }, { stamp: 20, value: 20 }, { stamp: 30, value: 80 }];
  assert.equal(seriesValueAt(points, 9), null);
  for (const stamp of [10, 16.5, 20, 29.99]) assert.equal(seriesValueAt(points, stamp), 20);
  assert.equal(seriesValueAt(points, 30), 80);
  assert.equal(seriesValueAt(points, 50), 80);
  const series = [{ name: 'step', value: seriesValueAt(points, 29) }, { name: 'other', value: 40 }];
  assert.equal(nearestSeriesName(series, 21, (value) => value), 'step');
});

test('hover matches the drawn step across missing and invalid observations', () => {
  const points = [{ stamp: 10, value: 20 }, { stamp: 20, value: null }, { stamp: 30, value: NaN }, { stamp: 500, value: 40 }];
  assert.equal(seriesValueAt(points, 400), 20);
  assert.equal(seriesValueAt(points, 500), 40);
  assert.equal(seriesValueAt([{ stamp: 10, value: null }], 20), null);
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

test('chart hover age uses compact elapsed time', () => {
  const capturedAt = 10_000;
  assert.equal(historyTimeAgo(capturedAt, (capturedAt + 42) * 1000), '42s ago');
  assert.equal(historyTimeAgo(capturedAt, (capturedAt + 3600) * 1000), '1h ago');
  assert.equal(historyTimeAgo(capturedAt, (capturedAt + 35 * 86400) * 1000), '1mo ago');
});
