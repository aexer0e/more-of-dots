import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';

// The app uses bundler-style TS imports. Resolve them for Node's test runner.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/src/map-editor/lib/')) {
    const url = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(url)) return nextResolve(url.href, context);
  }
  return nextResolve(specifier, context);
} });
const { normalizeMapData, cloneMapData, scaleMapObjects, snapshotForHistory, applySnapshot, mapDataForStorage, cloneStoredMapRecord, withTeamCount, inferTeamCount } = await import('../src/map-editor/lib/mapCodec.ts');
const { shockIndexes, mergeShocks, startingTerritory } = await import('../src/map-editor/lib/preview.ts');
const infantry = (count, x) => Array.from({ length: count }, (_, i) => [x, 100 + 10 * i]);
const raw = { map_surface: 'existing-png', infantry: [infantry(5, 100), [[900, 100]]], tanks: [[], []], cities: [], capitals: [], bridges: [], future_field: 42 };

test('maps keep only fields the game reads, and teams come from the unit lists', () => {
  const data = normalizeMapData({ ...raw, mode: 'v4' });
  assert.equal('mode' in data, false);
  assert.equal('motorised' in data, false);
  assert.equal(inferTeamCount(data), 2);
  assert.equal(data.future_field, 42);
  const four = withTeamCount(data, 4);
  assert.equal(four.infantry.length, 4);
  assert.deepEqual(four.tanks[3], []);
  assert.deepEqual(withTeamCount(four, 2).infantry, data.infantry);
});

test('shock units listed apart rejoin the infantry where experiment matches take them from', () => {
  const data = normalizeMapData({ ...raw, motorised: [[[50, 50]], []] });
  assert.equal(data.infantry[0].length, 6);
  assert.deepEqual(data.infantry[0][5], [50, 50]);
  assert.deepEqual([...shockIndexes(6)], [5]);
  // Counts that do not fit the rule add them after the infantry.
  const uneven = normalizeMapData({ ...raw, motorised: [[], [[1, 1], [2, 2]]] });
  assert.deepEqual(uneven.infantry[1], [[900, 100], [1, 1], [2, 2]]);
});

test('the shock rule matches the engine: every fifth from the last, never the first', () => {
  assert.deepEqual([...shockIndexes(1)], []);
  assert.deepEqual([...shockIndexes(2)], [1]);
  assert.deepEqual([...shockIndexes(18)].sort((a, b) => a - b), [2, 7, 12, 17]);
  for (let count = 1; count < 40; count += 1) {
    const units = infantry(count, 0);
    const shocks = [...shockIndexes(count)].map((index) => units[index]);
    const rest = units.filter((_, index) => !shockIndexes(count).has(index));
    assert.deepEqual(mergeShocks(rest, shocks), units, `count ${count}`);
  }
});

test('clones and history snapshots are independent', () => {
  const data = normalizeMapData(raw);
  const clone = cloneMapData(data);
  clone.infantry[0][0][0] = 999;
  assert.equal(data.infantry[0][0][0], 100);
  const map = { name: 'test', data };
  const saved = snapshotForHistory(map);
  data.infantry[0].push([1, 2]);
  assert.equal(applySnapshot(map, saved).data.infantry[0].length, 5);
});

test('resize and game coordinate roundtrip keep units', () => {
  const data = normalizeMapData(raw);
  assert.deepEqual(scaleMapObjects(data, 2, 3).infantry[1], [[1800, 300]]);
  const map = { id: 'x', name: 'test', width: 960, height: 540, teamCount: 2, data };
  const stored = mapDataForStorage(map);
  assert.deepEqual(stored.infantry[1], [[1500, 167]]);
  const reopened = cloneStoredMapRecord({ ...map, data: stored });
  assert.deepEqual(reopened.data.infantry[1], [[900, 100]]);
  assert.equal(reopened.data.future_field, 42);
});

test('starting territory splits between teams and cities take the nearest unit', () => {
  const data = normalizeMapData({ ...raw, infantry: [[[100, 270]], [[860, 270]]], cities: [[150, 270], [800, 270]] });
  const territory = startingTerritory(data, 2, 960, 5 / 3);
  assert.equal(territory.width, 160);
  assert.equal(territory.height, 90);
  assert.deepEqual(territory.cityOwners, [0, 1]);
  const owner = (x, y) => territory.owners[x * territory.height + y];
  assert.equal(owner(10, 45), 0);
  assert.equal(owner(150, 45), 1);
});
