import assert from 'node:assert/strict';
import test from 'node:test';
import { zoomView } from '../src/player/view.js';

test('zoom keeps the map point under the cursor stationary', () => {
  const initial = { zoom: 1, x: 0, y: 0 }, anchor = [.25, .7];
  const zoomed = zoomView(initial, anchor, 2);
  assert.equal(zoomed.zoom, 2);
  for (const [index, axis] of ['x', 'y'].entries())
    assert.ok(Math.abs((anchor[index] - zoomed[axis]) / zoomed.zoom - anchor[index]) < 1e-12);
  assert.deepEqual(zoomView(zoomed, anchor, .5), initial);
});

test('zoom limits and translations keep every viewport edge covered', () => {
  let view = { zoom: 1, x: 0, y: 0 };
  for (const anchor of [[0, 0], [1, 1], [.15, .9], [.9, .2]]) {
    for (const factor of [100, .7, 1.1, .6]) {
      view = zoomView(view, anchor, factor);
      assert.ok(view.zoom >= 1 && view.zoom <= 6);
      assert.ok(view.x <= 0 && view.y <= 0);
      assert.ok(view.x + view.zoom >= 1 && view.y + view.zoom >= 1);
    }
  }
  assert.deepEqual(zoomView(view, [.8, .3], .001), { zoom: 1, x: 0, y: 0 });
});
