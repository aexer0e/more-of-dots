import assert from 'node:assert/strict';
import test from 'node:test';
import { cached, historyPath, retrieve } from '../src/leaderboard/client.ts';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
};

test('history URLs are stable and encode player names', () => {
  assert.equal(historyPath('elo', ['b&c', 'a', 'a'], 7, 123), historyPath('elo', ['a', 'b&c'], 7, 123));
  const url = new URL(historyPath('elo', ['b&c'], 30, 123), 'https://example.test');
  assert.deepEqual(url.searchParams.getAll('player'), ['b&c']);
});

test('deduplicates concurrent requests and reuses persistent fresh data', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ capturedAt: Date.now() / 1000, elo: [], world: [] }), { headers: { ETag: '"abc"' } }); };
  const [a, b] = await Promise.all([retrieve('/v1/leaderboard'), retrieve('/v1/leaderboard')]);
  assert.deepEqual(a, b);
  await retrieve('/v1/leaderboard');
  assert.equal(requests, 1);
});

test('expired cache sends ETag and keeps data after 304', async () => {
  const path = '/test-304';
  const data = { rows: [] };
  values.set('mod.leaderboard.v1:' + path, JSON.stringify({ data, etag: '"old"', expires: 0, saved: 0 }));
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers['If-None-Match'], '"old"');
    return new Response(null, { status: 304 });
  };
  assert.deepEqual(await retrieve(path), data);
  assert.ok(cached(path).expires > Date.now());
});

test('failed refresh leaves offline data intact and can retry', async () => {
  const path = '/test-offline';
  values.set('mod.leaderboard.v1:' + path, JSON.stringify({ data: { rows: [] }, etag: '', expires: 0, saved: 0 }));
  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(retrieve(path), /offline/);
  assert.deepEqual(cached(path).data, { rows: [] });
  globalThis.fetch = async () => new Response('{"rows":[1]}');
  assert.deepEqual(await retrieve(path), { rows: [1] });
});
