import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { decodeJson, latestReplayFiles, exampleReplayFiles, safeMapPath, replayNames } from './dev-data.mjs';
import { readInstalledMaps } from './installed-maps.mjs';

test('installed map discovery refreshes after updates and excludes user map folders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mod-installed-maps-'));
  try {
    for (const folder of ['assets/zolamare_maps', 'assets/custom_maps', 'map_editor']) {
      await fs.mkdir(path.join(root, folder), { recursive: true });
    }
    const replay = { map: { path: 'assets/zolamare_maps/map55.png' } };
    assert.equal(await (await readInstalledMaps(root)).isVanilla(replay), false);
    await fs.writeFile(path.join(root, replay.map.path), 'official image');
    await fs.writeFile(path.join(root, 'assets/custom_maps/custom.png'), 'user map');
    await fs.writeFile(path.join(root, 'map_editor/generated_map55.png'), 'editor map');
    const catalog = await readInstalledMaps(root);
    assert.equal(await catalog.isVanilla(replay), true);
    const identity = await catalog.identity(replay);
    assert.deepEqual(identity, { mapKey: 'vanilla:assets/zolamare_maps/map55.png', mapLabel: 'Zolamare 55' });
    assert.deepEqual(await catalog.identity({ map: 55 }), identity);
    assert.deepEqual(await catalog.identity({ map: { map_surface: Buffer.from('official image').toString('base64') } }), identity);
    const custom = Buffer.from('user map').toString('base64');
    const first = await catalog.identity({ map: { path: 'old.png', map_surface: custom } });
    const renamed = await catalog.identity({ map: { path: 'new.png', map_surface: `data:image/png;base64,${custom}` } });
    assert.deepEqual(first, renamed);
    assert.match(first.mapKey, /^custom:[a-f0-9]{64}$/);
    assert.match(first.mapLabel, /^#[a-f0-9]{10}$/);
    assert.notDeepEqual(await catalog.identity({ map: { map_surface: Buffer.from('other image').toString('base64') } }), first);
    assert.deepEqual(await catalog.identity({}), { mapKey: null, mapLabel: null });
    assert.equal(await catalog.isVanilla({ map: replay.map.path.replaceAll('/', '\\') }), true);
    assert.equal(await catalog.isVanilla({ custom_map: null, map: { map_surface: Buffer.from('official image').toString('base64') } }), true);
    for (const map_surface of ['user map', 'editor map'].map((s) => Buffer.from(s).toString('base64'))) {
      assert.equal(await catalog.isVanilla({ map: { ...replay.map, map_surface } }), false);
    }
    for (const file of ['assets/custom_maps/custom.png', 'map_editor/generated_map55.png', 'assets/zolamare_maps/../custom_maps/custom.png']) {
      assert.equal(await catalog.isVanilla({ map: { path: file } }), false);
    }
    const missing = await readInstalledMaps(path.join(root, 'missing'));
    assert.equal(await missing.isVanilla(replay), false);
    assert.equal(await missing.isVanilla({ map: 35 }), true);
    assert.equal(await catalog.isVanilla({}), false);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true });
  }
});

test('fills from backups after live replays, skipping duplicates and preserving same-name files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mod-examples-test-'));
  try {
    const primary = path.join(directory, 'live'), backup = path.join(directory, 'backup');
    await fs.mkdir(primary); await fs.mkdir(backup);
    const live = JSON.stringify({ map: '1', end: 30 });
    await fs.writeFile(path.join(primary, 'same.rep'), live);
    await fs.utimes(path.join(primary, 'same.rep'), 1, 1);
    // Duplicates must not consume the available backup slots, even if they are newer.
    for (let i = 0; i < 105; i++) {
      const file = path.join(backup, `duplicate-${i}.rep`);
      await fs.writeFile(file, live);
      await fs.utimes(file, 3000000000, 3000000000);
    }
    await fs.writeFile(path.join(backup, 'same.rep'), JSON.stringify({ map: '2', end: 60 }));
    await fs.utimes(path.join(backup, 'same.rep'), 2999999999, 2999999999);
    for (let i = 0; i < 110; i++) await fs.writeFile(path.join(backup, `unique-${i}.rep`), JSON.stringify({ map: String(i + 3), end: 60 }));
    const files = await exampleReplayFiles(primary, backup);
    assert.equal(files.length, 100);
    assert.equal(files[0].sourcePath, path.join(primary, 'same.rep'), 'live replays have priority');
    assert.equal(files[1].sourcePath, path.join(backup, 'same.rep'));
    assert.notEqual(files[0].name, files[1].name, 'different replays with the same filename survive');
    assert.equal(new Set(files.map((file) => file.name)).size, 100);
    assert.ok(files.slice(1).every((file) => file.sourcePath.startsWith(backup + path.sep)));
    assert.ok(files.every((file) => !file.sourcePath.includes('duplicate-')));
    const collision = await exampleReplayFiles(primary, backup, 1000);
    assert.equal(collision.length, 100, 'callers cannot exceed the cap');
    assert.equal((await exampleReplayFiles(primary, path.join(directory, 'missing'))).length, 1);
    assert.equal((await exampleReplayFiles(primary, backup, 1)).length, 1);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true });
  }
});

test('copies only the newest 100 replay candidates', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mod-examples-test-'));
  try {
    for (let i = 0; i < 125; i++) {
      const file = path.join(directory, `${i}.rep`);
      await fs.writeFile(file, '{}');
      await fs.utimes(file, 1000 + i, 1000 + i);
    }
    await fs.writeFile(path.join(directory, 'config.txt'), 'not a replay');
    const files = await latestReplayFiles(directory, 1000);
    assert.equal(files.length, 100);
    assert.equal(files[0].name, '124.rep');
    assert.equal(files.at(-1).name, '25.rep');
    assert.equal((await fs.readdir(directory)).length, 126, 'source files remain untouched');
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true });
  }
});

test('new map paths resolve only inside the game directory', () => {
  const root = path.resolve('game');
  assert.equal(safeMapPath(root, 'assets/eronion_maps/azure_rivers.png'), path.join(root, 'assets/eronion_maps/azure_rivers.png'));
  for (const value of ['../config.txt', 'assets/../../private.png', 'C:/private.png', '//host/map.png', 'assets/C:/map.png']) assert.equal(safeMapPath(root, value), null);
});

test('reads both replay encodings and new nested player names', () => {
  const raw = { mode: 'experiment', map: { path: 'assets/fahero_maps/map50.png', motorised: [[[10, 20]], []] }, player_usernames: [[{ username: 'one', title: 'General' }], [{ username: 'two' }]] };
  const bytes = Buffer.from(JSON.stringify(raw));
  assert.deepEqual(decodeJson(bytes), raw);
  assert.deepEqual(decodeJson(gzipSync(bytes)), raw);
  assert.deepEqual(replayNames(raw), ['one', 'two']);
  assert.deepEqual(replayNames({ player_usernames: ['old [Badge]', 'other'] }), ['old', 'other']);
});
