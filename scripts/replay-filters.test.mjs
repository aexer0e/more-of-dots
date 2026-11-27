import assert from 'node:assert/strict';
import test from 'node:test';
import { MATCH_TYPES, matchType, matchesReplay, matchupTitle, normalize, replaySuggestions, toggleMatchType } from '../src/replays/filters.ts';
import { details } from '../share/src/replay.js';
import { canonical, expiry } from '../share/src/leaderboard.js';
import { columns } from '../share/src/listing.js';

const filters = (overrides = {}) => ({ query: '', enabledTypes: new Set(MATCH_TYPES), sources: new Set(['vanilla', 'custom']),
  durationRange: { min: 0, max: 1000 }, player: null, mapKey: null, ...overrides });
const record = (names, mapKey, overrides = {}) => ({ names, normalizedNames: names.map(normalize), mapKey,
  mapLabel: mapKey === 'f14' ? 'Fahero 14' : mapKey === 'z25' ? 'Zolamare 25' : '#a7c91e2f01',
  mapSource: mapKey.startsWith('custom:') ? 'custom' : 'vanilla', variant: mapKey.startsWith('custom:') ? 'custom' : 'vanilla',
  matchType: '1v1', durationSeconds: 120,
  modified: 100, teams: names.map((_, index) => index), winnerTeam: 0, isDraw: false, ...overrides });
const records = [record(['Ann', 'Bob'], 'f14'), record(['Anna', 'Bob'], 'f14'), record(['Ann', 'Cara'], 'z25'),
  record(['Ann', 'Bob'], 'custom:a7c91e2f01full'), record(['Ann', 'Dan'], 'f14', { winnerTeam: -1, isDraw: true })];

test('exact player and map selections combine, while draft search matches either entity', () => {
  assert.equal(records.filter(r => matchesReplay(r, filters({ player: 'ann' }))).length, 4);
  assert.equal(records.filter(r => matchesReplay(r, filters({ player: 'ann', mapKey: 'f14' }))).length, 2);
  assert.equal(records.filter(r => matchesReplay(r, filters({ query: 'anna' }))).length, 1);
  assert.equal(records.filter(r => matchesReplay(r, filters({ query: 'zolamare' }))).length, 1);
  assert.equal(records.filter(r => matchesReplay(r, filters({ query: '#a7c' }))).length, 1);
  assert.equal(records.filter(r => matchesReplay(r, filters({ query: '#a7c91e2f01full' }))).length, 1);
  assert.equal(replaySuggestions(records, filters({ query: '#' })).length, 1);
});

test('source, mode and inclusive duration constraints apply together', () => {
  assert.equal(records.filter(r => matchesReplay(r, filters({ sources: new Set(['custom']) }))).length, 1);
  assert.equal(records.filter(r => matchesReplay(r, filters({ enabledTypes: new Set(['3P']) }))).length, 0);
  assert.ok(matchesReplay(records[0], filters({ durationRange: { min: 120, max: 120 } })));
  assert.ok(!matchesReplay(records[0], filters({ durationRange: { min: 121, max: 500 } })));
  assert.ok(!matchesReplay(records[0], filters({ sources: new Set() })));
});

test('map suggestions replace current map, keep selected player and retain full keys', () => {
  const items = replaySuggestions(records, filters({ player: 'ann', mapKey: 'f14' }));
  const maps = items.filter(item => item.kind === 'map');
  assert.deepEqual(maps.map(item => [item.key, item.replayCount]), [['f14', 2], ['custom:a7c91e2f01full', 1], ['z25', 1]]);
  assert.equal(replaySuggestions(records, filters({ query: 'a7c91e2f01full' }))[0].key, 'custom:a7c91e2f01full');
  const players = items.filter(item => item.kind === 'player');
  assert.ok(players.some(item => item.name === 'Anna'), 'alternative players remain selectable on the current map');
  assert.ok(!players.some(item => item.name === 'Cara'), 'players respect the selected map');
});

test('player autocomplete preserves wins, losses, draws and frequent opponents', () => {
  const items = replaySuggestions(records, filters({ mapKey: 'f14' }));
  const ann = items.find(item => item.kind === 'player' && item.key === 'ann');
  assert.deepEqual([ann.replayCount, ann.winCount, ann.lossCount, ann.drawCount], [2, 1, 0, 1]);
  assert.deepEqual(ann.opponents, ['Bob', 'Dan']);
  const bob = items.find(item => item.kind === 'player' && item.key === 'bob');
  assert.equal(bob.lossCount, 2);
});

test('both suggestion groups have their own limit and exact matches rank first', () => {
  const items = replaySuggestions(records, filters({ query: 'ann' }), 1);
  assert.equal(items[0].name, 'Ann');
  const all = replaySuggestions(records, filters(), 1);
  assert.deepEqual(all.map(item => item.kind), ['player', 'map']);
  assert.deepEqual(replaySuggestions(records, filters({ query: 'no-match' })), []);
});

test('same mode clears to all, different mode replaces selection', () => {
  const duel = toggleMatchType(new Set(MATCH_TYPES), '1v1');
  assert.deepEqual([...duel], ['1v1']);
  assert.deepEqual([...toggleMatchType(duel, '1v1')], MATCH_TYPES);
  assert.deepEqual([...toggleMatchType(duel, '3P')], ['3P']);
});

test('experiment is a mode, so its replays still filter by map source', () => {
  const experiment = record(['Ann', 'Eve'], 'f14', { matchType: 'Experiment', variant: 'custom' });
  assert.ok(matchesReplay(experiment, filters({ enabledTypes: new Set(['Experiment']), sources: new Set(['custom']) })));
  assert.ok(!matchesReplay(experiment, filters({ enabledTypes: new Set(['Experiment']), sources: new Set(['vanilla']) })));
  assert.ok(!matchesReplay(experiment, filters({ enabledTypes: new Set(['1v1']) })));
});

test('2v2 teammates win together and are not each other\'s opponents', () => {
  const duo = record(['Ann', 'Bob', 'Cara', 'Dan'], 'f14', { matchType: '2v2', teams: [0, 0, 1, 1], winnerTeam: 1 });
  const [ann] = replaySuggestions([duo], filters({ query: 'ann' }));
  assert.equal(ann.winCount, 0);
  assert.equal(ann.lossCount, 1);
  assert.deepEqual(ann.opponents, ['Cara', 'Dan']);
  const [dan] = replaySuggestions([duo], filters({ query: 'dan' }));
  assert.equal(dan.winCount, 1);
  assert.ok(matchesReplay(duo, filters({ player: 'bob' })), 'each teammate can be filtered on');
});

test('matchup titles group teammates', () => {
  const players = [{ name: 'a', teamIndex: 0 }, { name: 'b', teamIndex: 0 }, { name: 'c', teamIndex: 1 }, { name: 'd', teamIndex: 1 }];
  assert.equal(matchupTitle(players), 'a & b vs c & d');
  assert.equal(matchupTitle(players, '-vs-', ' _ '), 'a _ b-vs-c _ d');
  assert.equal(matchupTitle([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), 'a vs b vs c');
});

test('the match format comes from the mode, or from the sides and team size', () => {
  assert.equal(matchType('v3', 3, 1), '3P');
  assert.equal(matchType('avalanche', 2, 1), 'Avalanche');
  assert.equal(matchType('ffa', 4, 1), '4P');
  assert.equal(matchType(null, 2, 2), '2v2');
  assert.equal(matchType(undefined, 2, 1), '1v1');
  assert.equal(matchType('unknown', 3, 1), '3P');
});

test('the share worker reads the fields of a replay, not those of its map or orders', () => {
  const text = JSON.stringify({ version: '1.4.1', map: { path: 'assets/fahero_maps/map4.png', mode: 'v4' },
    player_usernames: [[{ username: 'a' }, { username: 'b' }], [{ username: 'c' }, { username: 'd' }]], mode: '2v2',
    10: [{ mode: 'experiment', end: 3 }], 250: [] });
  assert.deepEqual(details(text), { players: ['a & b', 'c & d'], frames: 250, version: '1.4.1', mode: '2v2', custom: false,
    mapRef: 'assets/fahero_maps/map4.png', surface: null });
  const custom = details(JSON.stringify({ custom_map: { map_surface: 'iVBORw0KGgo=' }, player_names: ['x', 'y', 'z'], end: 90 }));
  assert.deepEqual([custom.mode, custom.custom, custom.mapRef, custom.frames, custom.players], ['3P', true, null, 90, ['x', 'y', 'z']]);
});

test('the share worker asks the same leaderboard question in one form', () => {
  const ask = (query) => canonical('/v1/leaderboard/refresh', new URLSearchParams(query));
  assert.equal(ask('player=b&days=7&player=a&player=a&since=123&board=world'), '/v1/leaderboard/refresh?board=world&days=7&player=a&player=b');
  assert.equal(ask('board=other&days=5'), '/v1/leaderboard/refresh?board=elo&days=0');
  assert.equal(ask(Array.from({ length: 12 }, (_, i) => `player=p${i}`).join('&')), null);
  assert.equal(canonical('/v1/leaderboard', new URLSearchParams('player=a')), '/v1/leaderboard');
  assert.equal(canonical('/v1/nations', new URLSearchParams()), null);
});

test('the share worker keeps a leaderboard answer until the next snapshot is due', () => {
  const now = 1_000_000_000;
  assert.equal(expiry({ capturedAt: now / 1000 - 30, refreshIntervalSeconds: 120 }, now), now + 100_000);
  assert.equal(expiry({ capturedAt: now / 1000 - 500, refreshIntervalSeconds: 120 }, now), now + 20_000);
  assert.equal(expiry({}, now), now + 120_000);
});

test('the share worker keys maps as More of Dots tells them apart', async () => {
  const official = await columns(JSON.stringify({ map: { path: 'Assets\\Fahero_maps\\map4.png' }, player_names: ['a', 'b'], end: 30 }));
  assert.equal(official.mapKey, 'vanilla:assets/fahero_maps/map4.png');
  const image = 'iVBORw0KGgo=';
  const custom = await columns(JSON.stringify({ custom_map: { map_surface: image }, player_names: ['a', 'b'], end: 30 }));
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(image, 'base64'))).toString('hex');
  assert.equal(custom.mapKey, `custom:${digest}`);
});
