import assert from 'node:assert/strict';
import test from 'node:test';
import { lastActivities, sortPlayers, activityLabel } from '../src/leaderboard/activity.ts';

const player = (nickname, rank, value) => ({ nickname, rank, value, faction: 'neutral' });
const snapshot = (capturedAt, elo, world = []) => ({ capturedAt, elo, world });

test('activity uses score changes on either board, ignores rank shifts and first sightings', () => {
  const history = [
    snapshot(100, [player('a', 1, 100), player('b', 2, 90)], [player('a', 1, 10)]),
    snapshot(200, [player('a', 2, 100), player('b', 1, 110), player('new', 3, 80)], [player('a', 1, 11)]),
    snapshot(300, [player('a', 2, 100), player('b', 1, 110)]),
  ];
  assert.deepEqual([...lastActivities(history.reverse())].sort(), [['a', 200], ['b', 200]]);
  assert.equal(history[0].capturedAt, 300);
  assert.equal(lastActivities([snapshot(1, [player('a', 1, 100)]), snapshot(2, []), snapshot(3, [player('a', 1, 120)])]).size, 0);
});

test('sorts both ways, breaks activity ties by rank and always puts unknowns last', () => {
  const players = [player('a', 1, 100), player('b', 2, 90), player('c', 3, 80), player('d', 4, 70)];
  const activity = new Map([['b', 100], ['c', 200], ['d', 200]]);
  const names = (key, descending) => sortPlayers(players, activity, { key, descending }).map(p => p.nickname);
  assert.deepEqual(names('activity', true), ['c', 'd', 'b', 'a']);
  assert.deepEqual(names('activity', false), ['b', 'c', 'd', 'a']);
  assert.deepEqual(names('rank', false), ['a', 'b', 'c', 'd']);
  assert.deepEqual(names('rank', true), ['d', 'c', 'b', 'a']);
  assert.equal(players[0].nickname, 'a');
});

test('compact activity times handle boundaries and clock skew', () => {
  assert.equal(activityLabel(100, 99_000), 'Just now');
  assert.equal(activityLabel(100, 160_000), '1m ago');
  assert.equal(activityLabel(100, 3_700_000), '1h ago');
  assert.equal(activityLabel(100, 86_500_000), '1d ago');
});
