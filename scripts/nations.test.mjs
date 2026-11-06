import assert from 'node:assert/strict';
import test from 'node:test';
import { blueShare, slopeStops, compactRow, dailyRows, mergeRows, nextCheckDelay, rangeRows, rangeStart, settle, shareAxis } from '../src/nations/data.ts';

const DAY = 86400;
const row = (t, bp = 50) => ({ t, id: t, hash: String(t), rp: 100 - bp, bp, rc: 10, bc: 12 });
const every30 = (from, to) => { const rows = []; for (let t = from; t <= to; t += 1800) rows.push(row(t)); return rows; };

test('API rows without totals are skipped', () => {
  const api = { id: 1, capturedAt: 100, mapHash: 'h', width: 1920, height: 1080, encoding: 'playable-bitset-zlib-v1', playablePixels: 10, mapUrl: '/m', redPixels: 4, bluePixels: 6, redCities: 1, blueCities: 2 };
  assert.deepEqual(compactRow(api), { t: 100, id: 1, hash: 'h', rp: 4, bp: 6, rc: 1, bc: 2 });
  assert.equal(compactRow({ ...api, redCities: null }), null);
});

test('daily rows keep the last capture of each UTC day', () => {
  const rows = [row(DAY * 10 + 60), row(DAY * 10 + 3600), row(DAY * 11), row(DAY * 11 + 10)];
  assert.deepEqual(dailyRows(rows).map((entry) => entry.t), [DAY * 10 + 3600, DAY * 11 + 10]);
});

test('merging replaces captures with the same timestamp and sorts', () => {
  assert.deepEqual(mergeRows([row(3), row(1)], [row(2), row(3, 70)]).map((entry) => [entry.t, entry.bp]), [[1, 50], [2, 50], [3, 70]]);
});

test('captures older than the recent window collapse to one per day', () => {
  const latest = DAY * 40;
  const { recent, daily } = settle(every30(DAY * 20, latest), [], latest);
  assert.ok(recent.every((entry) => entry.t >= latest - 8 * DAY));
  assert.ok(daily.length <= 13);
  assert.equal(new Set(daily.map((entry) => Math.floor(entry.t / DAY))).size, daily.length);
});

test('week ranges use every capture and longer ranges one per day', () => {
  const latest = DAY * 100;
  const recent = every30(latest - 8 * DAY, latest);
  const daily = dailyRows(every30(latest - 60 * DAY, latest - 8 * DAY - 1800));
  assert.equal(rangeRows(recent, daily, '24h').length, 49);
  assert.equal(rangeRows(recent, daily, '1w').length, 7 * 48 + 1);
  const month = rangeRows(recent, daily, '30d');
  assert.ok(month.length >= 30 && month.length <= 31);
  assert.equal(month.at(-1).t, latest);
  assert.equal(rangeRows(recent, daily, 'all').length, 61);
});

test('only daily ranges need older history', () => {
  assert.equal(rangeStart('1w', 1000 * DAY, 0), null);
  assert.equal(rangeStart('30d', 1000 * DAY, 0), 970 * DAY);
  assert.equal(rangeStart('all', 1000 * DAY, 123), 123);
});

test('checks wait for the next capture and never retry faster than five minutes', () => {
  const latest = 1_000_000;
  const now = (latest + 600) * 1000;
  assert.equal(nextCheckDelay(latest, 0, now), (1800 + 60 - 600) * 1000);
  const late = (latest + 2400) * 1000;
  assert.equal(nextCheckDelay(latest, late - 1000, late), 299_000);
  assert.equal(nextCheckDelay(latest, late - 400_000, late), 0);
  assert.equal(nextCheckDelay(null, 0, now), 0);
});

test('shares are Blue percentages', () => {
  assert.deepEqual(blueShare({ ...row(0), rp: 47, bp: 53, rc: 141, bc: 154 }), { land: 53, cities: 154 / 295 * 100 });
});

test('the axis fits small movements instead of reaching for 50%', () => {
  const axis = shareAxis([74.52, 74.61, 74.9]);
  assert.ok(axis.low > 74 && axis.low < 74.52, `low ${axis.low}`);
  assert.ok(axis.high > 74.9 && axis.high < 75.3, `high ${axis.high}`);
  assert.ok(axis.ticks.length >= 3 && axis.ticks.length <= 8);
  assert.ok(axis.ticks.every((tick) => tick >= axis.low && tick <= axis.high));
  assert.equal(axis.decimals, 1);
  const flat = shareAxis([60, 60]);
  assert.ok(flat.high - flat.low >= 0.12 && flat.decimals === 2);
  const wide = shareAxis([40, 60]);
  assert.ok(wide.low < 40 && wide.high > 60 && wide.ticks.includes(50));
});

test('line colour follows direction: blue rising, red falling, grey flat', () => {
  const hour = 3600;
  const times = [0, 1, 2, 3, 4, 5, 6].map((index) => index * hour);
  const values = [50, 51, 52, 52, 52, 51.5, 51];
  const stops = slopeStops(times, values);
  const rgb = (stop) => stop.color.match(/\d+/g).map(Number);
  assert.equal(stops.length, 7);
  assert.equal(stops[0].offset, 0);
  assert.equal(stops.at(-1).offset, 1);
  const [r1, , b1] = rgb(stops[1]);
  assert.ok(b1 > r1, 'rising toward Blue is blue');
  assert.deepEqual(rgb(stops[3]), [138, 130, 152], 'flat is neutral');
  const [r5, , b5] = rgb(stops[5]);
  assert.ok(r5 > b5, 'falling toward Red is red');
  assert.deepEqual(slopeStops([0], [50]), []);
});
