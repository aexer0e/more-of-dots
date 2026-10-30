import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTroopStore, troopLinesMarkup } from '../src/replays/troop-lines.ts';

test('the store skips damaged lines and keeps the latest entry for a replay', () => {
  const lines = parseTroopStore('{"h":"a","s":[[1,2]]}\nnot json\n{"h":"b","s":[]}\n{"h":"a","s":[[3,4]]}\n{"h":"c","s":[[1');
  assert.deepEqual([...lines.keys()], ['a', 'b']);
  assert.deepEqual(lines.get('a'), [[3, 4]]);
  assert.equal(parseTroopStore('').size, 0);
});

test('each side gets one path, in its own colour, spanning the card', () => {
  const markup = troopLinesMarkup([[10, 5, 2], [10, 8, 9]]);
  assert.equal(markup.match(/<path /g).length, 2);
  assert.match(markup, /troop-side-1/);
  assert.match(markup, /troop-side-2/);
  const paths = [...markup.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]);
  assert.match(paths[0], /^M0 30C/);
  assert.match(paths[0], / 1000 \d+$/);
});

test('a wiped-out side stops where it reaches zero', () => {
  const [, line] = troopLinesMarkup([[4, 4, 4, 4, 4], [4, 2, 0, 0, 0]]).match(/troop-side-2" d="([^"]+)"/);
  assert.match(line, / 500 970$/);
});

test('replays without troops draw nothing', () => {
  assert.equal(troopLinesMarkup([]), '');
  assert.equal(troopLinesMarkup([[0, 0], [0, 0]]), '');
});
