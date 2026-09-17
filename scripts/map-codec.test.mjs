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
const { normalizeMapData, cloneMapData, scaleMapObjects, snapshotForHistory, applySnapshot, mapDataForStorage, cloneStoredMapRecord } = await import('../src/map-editor/lib/mapCodec.ts');
const raw = { mode: '1v1', map_surface: 'existing-png', infantry: [[], []], tanks: [[], []], motorised: [[[300, 450]], [[60, 90]]], cities: [], capitals: [], bridges: [], future_field: 42 };

test('old maps gain empty motorised buckets and new maps retain all teams', () => {
  const old = { ...raw }; delete old.motorised;
  assert.deepEqual(normalizeMapData(old).motorised, [[], []]);
  const normalized = normalizeMapData({ ...raw, motorised: [...raw.motorised, [[5, 10]], [[20, 30]]] });
  assert.equal(normalized.motorised.length, 4);
  assert.deepEqual(normalized.motorised[3], [[20, 30]]);
  assert.equal(normalized.infantry.length, 4);
});

test('motorised clones and history snapshots are independent', () => {
  const data = normalizeMapData(raw);
  const clone = cloneMapData(data);
  clone.motorised[0][0][0] = 999;
  assert.equal(data.motorised[0][0][0], 300);
  const map = { name: 'test', data };
  const saved = snapshotForHistory(map);
  data.motorised[0].push([1, 2]);
  assert.deepEqual(applySnapshot(map, saved).data.motorised[0], [[300, 450]]);
});

test('resize and game coordinate roundtrip include motorised positions', () => {
  const data = normalizeMapData(raw);
  assert.deepEqual(scaleMapObjects(data, 2, 3).motorised[0], [[600, 1350]]);
  const map = { id: 'x', name: 'test', width: 960, height: 540, teamCount: 2, data };
  const stored = mapDataForStorage(map);
  assert.deepEqual(stored.motorised[0], [[500, 750]]);
  const reopened = cloneStoredMapRecord({ ...map, data: stored });
  assert.deepEqual(reopened.data.motorised, data.motorised);
  assert.equal(reopened.data.future_field, 42);
});
