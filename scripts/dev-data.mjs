import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = path.join(project, 'build', 'dev-data');
const API = 'https://wod-nations-map.moreofdots.workers.dev';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function decodeJson(bytes) {
  return JSON.parse((bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : bytes).toString('utf8'));
}
export function safeMapPath(root, value) {
  if (typeof value !== 'string') return null;
  const relative = value.replaceAll('\\', '/');
  if (!/^(assets|map_editor)\/.+\.png$/.test(relative) || relative.split('/').some((p) => !p || p === '..' || p === '.' || p.includes(':'))) return null;
  const target = path.resolve(root, relative);
  return target.startsWith(path.resolve(root) + path.sep) ? target : null;
}
export function replayNames(raw) {
  const flatten = (p) => Array.isArray(p) ? p.map(flatten).filter(Boolean).join(' / ') : typeof p === 'object' && p ? flatten(p.username ?? p.name ?? p.display_name ?? p.displayName) : String(p ?? '').replace(/ \[.*\]$/, '').trim();
  const names = (raw.player_usernames ?? []).slice(0, 4).map(flatten);
  while (names.length < 2) names.push('');
  return names.map((name, i) => name || `Player ${i + 1}`);
}
async function replayFiles(directory) {
  if (!directory) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = await Promise.all(entries.filter((p) => p.isFile() && /\.(rep|json)$/i.test(p.name)).map(async (p) => ({ name: p.name, sourcePath: path.join(directory, p.name), modified: (await fs.stat(path.join(directory, p.name))).mtimeMs })));
  return files.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
}
export async function latestReplayFiles(directory, limit = 100) {
  return (await replayFiles(directory)).slice(0, Math.min(100, limit));
}
export async function exampleReplayFiles(primary, backup, limit = 100) {
  const selected = [], hashes = new Set(), names = new Set();
  const maximum = Math.max(0, Math.min(100, limit));
  for (const directory of [primary, backup]) {
    if (selected.length >= maximum) break;
    for (const file of await replayFiles(directory)) {
      try {
        const bytes = await fs.readFile(file.sourcePath);
        const digest = hash(bytes);
        if (hashes.has(digest)) continue;
        const raw = decodeJson(bytes);
        if (!raw || typeof raw !== 'object' || raw.map == null) continue;
        const name = names.has(file.name.toLowerCase()) ? `${digest}${path.extname(file.name)}` : file.name;
        selected.push({ ...file, name });
        hashes.add(digest); names.add(name.toLowerCase());
        if (selected.length >= maximum) break;
      } catch (error) { console.warn(`Skipping ${file.name}: ${error.message}`); }
    }
  }
  return selected;
}
async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
export async function seedExamples() {
  const game = process.env.WOD_GAME_DIR || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\War of Dots';
  await fs.mkdir(path.join(dataDir, 'replays'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'maps'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'images'), { recursive: true });
  let previous;
  try { previous = JSON.parse(await fs.readFile(path.join(dataDir, 'data.json'), 'utf8')); } catch { /* First run. */ }
  const catalog = JSON.parse(await fs.readFile(path.join(project, 'src-tauri/src/vanilla-maps.json'), 'utf8'));
  let identity = '';
  // Read only the username. Never copy the game configuration or credentials.
  try { identity = decodeJson(await fs.readFile(path.join(game, 'config.txt'))).login?.username ?? ''; } catch { /* Manual selection remains available. */ }
  const image = async (bytes) => {
    const name = hash(bytes) + '.png';
    await fs.writeFile(path.join(dataDir, 'images', name), bytes);
    return '/__examples/images/' + name;
  };
  const mapImage = async (raw) => {
    const map = raw.custom_map ?? raw.map;
    if (map?.map_surface) return Buffer.from(map.map_surface.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (map?.path) {
      const candidate = safeMapPath(game, map.path);
      if (candidate) return fs.readFile(candidate).catch(() => null);
    }
    if (/^\d+$/.test(String(map))) {
      for (const relative of [`assets/fahero_maps/map${map}.png`, `assets/zolamare_maps/map${map}.png`, `assets/eronion_maps/map${map}.png`, `map_editor/generated_map${map}.png`]) {
        try { return await fs.readFile(path.join(game, relative)); } catch { /* Try the next vanilla folder. */ }
      }
    }
    return null;
  };
  const replays = [], maps = [];
  const backup = process.env.WOD_REPLAY_BACKUP_DIR || (process.env.APPDATA ? path.join(process.env.APPDATA, 'local.more-of-dots', 'replay-backups') : null);
  const files = await exampleReplayFiles(path.join(game, 'replays'), backup);
  const copiedNames = new Set(files.map((file) => file.name));
  for (const name of await fs.readdir(path.join(dataDir, 'replays'))) {
    if (/\.(rep|json)$/i.test(name) && !copiedNames.has(name)) await fs.unlink(path.join(dataDir, 'replays', name));
  }
  for (const file of files) {
    try {
      const bytes = await fs.readFile(file.sourcePath);
      const raw = decodeJson(bytes);
      await fs.writeFile(path.join(dataDir, 'replays', file.name), bytes);
      const names = replayNames(raw), perspective = names.indexOf(identity);
      const winner = raw.result === 0.5 ? -1 : typeof raw.result === 'string' && names.includes(raw.result) ? names.indexOf(raw.result) : perspective >= 0 && names.length === 2 && [0, 1, false, true].includes(raw.result) ? (raw.result ? perspective : 1 - perspective) : -1;
      const seconds = Math.floor(Number(raw.end ?? Math.max(0, ...Object.keys(raw).filter((k) => /^\d+$/.test(k)).map(Number))) / 30);
      const png = await mapImage(raw);
      const hasEmbeddedMap = Boolean((raw.custom_map ?? raw.map)?.map_surface);
      const vanilla = hasEmbeddedMap ? png && catalog.pngHashes.includes(hash(png)) : /^\d+$/.test(String(raw.map)) || catalog.paths.includes(raw.map?.path?.replaceAll('\\', '/'));
      replays.push({ fileName: file.name, filePath: '/__examples/replays/' + file.name, version: raw.version, players: names.map((name, teamIndex) => ({ name, teamIndex, winner: winner === teamIndex })).sort((a, b) => Number(b.name === identity) - Number(a.name === identity)), draw: raw.result === 0.5, length: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`, durationSeconds: seconds, modified: Math.floor(file.modified / 1000), eventLabel: vanilla ? null : 'Custom', thumbnailDataUrl: png ? await image(png) : null });
      // Recent replay layouts include the new maps and Shock units for editor testing.
      if (png && typeof raw.map === 'object' && maps.length < 12) {
        const data = { ...raw.map, map_surface: png.toString('base64'), mode: raw.map.mode ?? (names.length === 4 ? 'v4' : names.length === 3 ? 'v3' : '1v1'), motorised: raw.map.motorised ?? names.map(() => []) };
        delete data.path;
        const id = `replay-map-${maps.length + 1}.txt`;
        await fs.writeFile(path.join(dataDir, 'maps', id), JSON.stringify(data));
        maps.push({ id, fileName: id, name: raw.map.path ? path.basename(raw.map.path, '.png').replaceAll('_', ' ') : `Custom ${maps.length + 1}`, data, width: png.readUInt32BE(16), height: png.readUInt32BE(20), teamCount: names.length, createdAt: file.modified, updatedAt: file.modified });
      }
    } catch (error) { console.warn(`Skipping ${file.name}: ${error.message}`); }
  }
  // Also copy the user's newest saved editor maps into the isolated example directory.
  const editorFiles = await fs.readdir(path.join(game, 'map_editor')).catch(() => []);
  const editorEntries = await Promise.all(editorFiles.filter((name) => name.endsWith('.txt')).map(async (name) => ({ name, modified: (await fs.stat(path.join(game, 'map_editor', name))).mtimeMs })));
  for (const file of editorEntries.sort((a, b) => b.modified - a.modified).slice(0, 12)) {
    try {
      const bytes = await fs.readFile(path.join(game, 'map_editor', file.name));
      const data = decodeJson(bytes);
      if (!data.map_surface) continue;
      const png = Buffer.from(data.map_surface, 'base64');
      await fs.writeFile(path.join(dataDir, 'maps', file.name), bytes);
      maps.push({ id: file.name, fileName: file.name, name: file.name.replace(/\.txt$/, '').replaceAll('_', ' '), data, width: png.readUInt32BE(16), height: png.readUInt32BE(20), teamCount: Math.max(2, data.infantry?.length ?? 0, data.tanks?.length ?? 0, data.motorised?.length ?? 0), createdAt: file.modified, updatedAt: file.modified });
    } catch { /* Ignore unrelated editor files. */ }
  }
  let leaderboard = previous?.leaderboard;
  try {
    const latest = await getJson(API + '/v1/leaderboard');
    const intervals = new Map();
    let before = latest.capturedAt + 1;
    // Copy all available six-hour samples, following the API cursor instead of its default week.
    while (true) {
      const history = await getJson(API + `/v1/leaderboard/history?from=0&step=21600&limit=336&top=100&to=${latest.capturedAt + 1}&before=${before}`);
      for (const row of history.rows) {
        const bucket = Math.floor(row.capturedAt / 21600);
        if (!intervals.has(bucket) || intervals.get(bucket).capturedAt < row.capturedAt) intervals.set(bucket, row);
      }
      if (history.nextBefore == null || history.nextBefore >= before) break;
      before = history.nextBefore;
    }
    leaderboard = { latest, history: [...intervals.values()].sort((a, b) => a.capturedAt - b.capturedAt) };
  } catch (error) {
    if (!leaderboard) throw new Error(`Could not seed leaderboard data: ${error.message}. Start online once to save a local copy.`);
    console.warn('Leaderboard unavailable; using the last saved example snapshot.');
  }
  const payload = { generatedAt: Date.now(), identity, replays, maps, leaderboard };
  await fs.writeFile(path.join(dataDir, 'data.json'), JSON.stringify(payload));
  console.log(`Examples ready: ${replays.length} replays (max 100), ${maps.length} maps, both leaderboards. Source files are untouched.`);
  return payload;
}
