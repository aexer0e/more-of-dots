import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheExpiry, cached, compactHistory, historyPath, leaderboardRankIndex, limitHistory, retrieve, mergeHistory, refreshLeaderboard } from '../src/leaderboard/client.ts';
import { eloWinGain } from '../src/leaderboard/elo.ts';

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

test('replay rank index includes only the current top 100 and matches names case-insensitively', () => {
  const snapshot = { capturedAt: 1, elo: [
    { rank: 1, nickname: 'Alpha', value: 2000, faction: 'blue' },
    { rank: 100, nickname: ' Bravo ', value: 1000, faction: 'red' },
    { rank: 101, nickname: 'Charlie', value: 900, faction: 'blue' },
  ], world: [] };
  assert.deepEqual([...leaderboardRankIndex(snapshot)], [['alpha', 1], ['bravo', 100]]);
});

test('estimated Elo win gain uses a 16-point factor, rounded and capped at 1–15', () => {
  assert.equal(eloWinGain(1000, 1000), 8);
  assert.equal(eloWinGain(1000, 600), 1);
  assert.equal(eloWinGain(1000, 1400), 15);
  assert.equal(eloWinGain(1000, 200), 1);
  assert.equal(eloWinGain(1000, 1800), 15);
  assert.ok(eloWinGain(1000, 1200) > eloWinGain(1000, 800));
});

test('cache expiration follows the refresh interval published by the server', () => {
  assert.equal(cacheExpiry({ capturedAt: 1000, refreshIntervalSeconds: 300 }, 1_120_000), 1_300_000);
  assert.equal(cacheExpiry({ capturedAt: 1000, refreshIntervalSeconds: 300 }, 1_400_000), 1_460_000);
  assert.equal(cacheExpiry({ capturedAt: 1000 }, 1_120_000), 2_800_000);
});

test('deduplicates concurrent requests and reuses persistent fresh data', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ capturedAt: Date.now() / 1000, refreshIntervalSeconds: 300, elo: [], world: [] }), { headers: { ETag: '"abc"' } }); };
  const [a, b] = await Promise.all([retrieve('/v1/leaderboard'), retrieve('/v1/leaderboard')]);
  assert.deepEqual(a, b);
  await retrieve('/v1/leaderboard');
  assert.equal(requests, 1);
});

test('forced refresh bypasses a fresh cache entry', async () => {
  const path = '/test-force';
  values.set('mod.leaderboard.v2:' + path, JSON.stringify({ data: { rows: ['old'] }, etag: '"old"', expires: Date.now() + 60_000, saved: 0 }));
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('{"rows":["new"]}'); };
  assert.deepEqual(await retrieve(path, true), { rows: ['new'] });
  assert.equal(requests, 1);
});

test('expired cache sends ETag and keeps data after 304', async () => {
  const path = '/test-304';
  const data = { rows: [] };
  values.set('mod.leaderboard.v3:' + path, JSON.stringify({ data, etag: '"old"', expires: 0, saved: 0 }));
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
  values.set('mod.leaderboard.v3:' + path, JSON.stringify({ data: { rows: [] }, etag: '', expires: 0, saved: 0 }));
  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(retrieve(path), /offline/);
  assert.deepEqual(cached(path).data, { rows: [] });
  globalThis.fetch = async () => new Response('{"rows":[1]}');
  assert.deepEqual(await retrieve(path), { rows: [1] });
});


test('incremental history replaces an open interval and expires old points without filling gaps', () => {
  const old = { from: 0, to: 200, step: 100, rows: [
    { capturedAt: 10, players: [] }, { capturedAt: 120, players: [{ nickname: 'a', rank: null, value: null }] },
    { capturedAt: 200, players: [{ nickname: 'a', rank: 1, value: 5 }] },
  ] };
  const delta = { from: 100, to: 240, step: 100, replaceFrom: 200, rows: [
    { capturedAt: 240, players: [{ nickname: 'a', rank: 2, value: 6 }] },
  ] };
  const result = mergeHistory(old, delta);
  assert.deepEqual(result.rows.map(r => r.capturedAt), [120, 240]);
  assert.equal(result.rows[0].players[0].value, null);
});

test('24-hour history requests exact change history and trims older points', async () => {
  let requestUrl;
  globalThis.fetch = async url => {
    requestUrl = new URL(url);
    return new Response(JSON.stringify({ capturedAt: 1_000_000, elo: [], world: [], history: {
      from: 395_200, to: 1_000_000, step: 21_600, replaceFrom: 395_200,
      rows: [
        { capturedAt: 900_000, players: [] },
        { capturedAt: 950_000, players: [] },
        { capturedAt: 1_000_000, players: [] },
      ],
    } }));
  };
  const result = await refreshLeaderboard('elo', ['24-hour-test'], 1, true);
  assert.equal(requestUrl.searchParams.get('days'), '1');
  assert.equal(result.history.from, 913_600);
  assert.deepEqual(result.history.rows.map((row) => row.capturedAt), [913_600]);
  assert.equal(limitHistory(result.history, 0), result.history);
});

test('history keeps every change while collapsing repeated states', () => {
  const point = (capturedAt, value) => ({ capturedAt, players: [{ nickname: 'a', rank: 1, value }] });
  const result = compactHistory({ from: 0, to: 500, step: 120, rows: [point(100, 1), point(220, 1), point(340, 2), point(460, 3)] });
  assert.deepEqual(result.rows.map((row) => row.capturedAt), [100, 340, 460]);
});

test('combined refresh makes one request, caches by selection and merges its next delta', async () => {
  let requests = 0;
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(new URL(url)); requests++;
    const stamp = requests === 1 ? 1700000010 : 1700000130;
    return new Response(JSON.stringify({ capturedAt: stamp, refreshIntervalSeconds: 120,
      elo: [], world: [], activity: { a: stamp },
      history: { from: 1600000000, to: stamp, step: 86400, replaceFrom: 1699920000,
        rows: [{ capturedAt: stamp, players: [{ nickname: 'a', rank: 1, value: requests }] }] } }));
  };
  await refreshLeaderboard('elo', ['incremental-test'], 7, true);
  const result = await refreshLeaderboard('elo', ['incremental-test'], 7, true);
  assert.equal(requests, 2);
  assert.equal(urls[0].pathname, '/v1/leaderboard/refresh');
  assert.equal(urls[1].searchParams.get('since'), '1700000010');
  assert.deepEqual(result.history.rows.map(r => r.capturedAt), [1700000130]);
  await refreshLeaderboard('elo', ['incremental-test'], 7);
  assert.equal(requests, 2);
});
