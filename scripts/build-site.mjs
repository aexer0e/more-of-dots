// Builds the hosted replay player into build/site: the player page, the
// WebAssembly engine compiled from engine/replay-sim-web, and the official maps.
//   node scripts/build-site.mjs [--audio <folder>] [--maps <folder>] [--tournaments <folder>] [--skip-engine]
// --audio copies the site's sound files, --maps the game's official map images
// (laid out as in the game, e.g. assets/zolamare_maps/map56.png) and --tournaments
// publishes its tournaments (scripts/tournaments.mjs). All are kept outside this
// repository. Each page's link preview is written last (scripts/og-cards.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeLinkPreviews } from './og-cards.mjs';
import { publishTournaments } from './tournaments.mjs';
import { reduceTroops } from '../src/replays/troop-lines.ts';

const project = path.resolve(import.meta.dirname, '..');
const at = (...parts) => path.join(project, ...parts);
const args = process.argv.slice(2);
const folder = (flag) => (args.includes(flag) ? path.resolve(args[args.indexOf(flag) + 1]) : null);
const audio = folder('--audio');
const gameMaps = folder('--maps');
const tournaments = folder('--tournaments');
const run = (command, parameters) => execFileSync(command, parameters, { cwd: project, stdio: 'inherit' });

// The engine needs Rust's wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown).
const engine = at('engine/target/wasm32-unknown-unknown/release/replay_sim_web.wasm');
if (!args.includes('--skip-engine'))
  run('cargo', ['build', '--release', '--manifest-path', at('engine/Cargo.toml'), '-p', 'replay-sim-web', '--target', 'wasm32-unknown-unknown']);

const site = at('build/site');
run(process.execPath, [at('node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.site.config.ts']);
fs.renameSync(path.join(site, 'site.html'), path.join(site, 'index.html'));

fs.mkdirSync(path.join(site, 'engine'), { recursive: true });
fs.copyFileSync(engine, path.join(site, 'engine/replay-sim.wasm'));
// Web addresses are case-sensitive; replays name maps in lower case. The game's
// own images, when given, replace the engine's copies of the same maps.
const published = new Set();
for (const maps of [at('engine/maps'), gameMaps].filter(Boolean))
  for (const file of fs.readdirSync(maps, { recursive: true }).filter(name => name.endsWith('.png'))) {
    const name = file.replaceAll('\\', '/').toLowerCase();
    const target = path.join(site, 'maps', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(maps, file), target);
    published.add(name);
  }
// The site finds the picture of a replay that only names its map in this list.
fs.writeFileSync(path.join(site, 'maps/index.json'), JSON.stringify([...published].sort()));
if (audio) fs.cpSync(audio, path.join(site, 'audio'), { recursive: true });
if (tournaments) {
  // Each published replay is simulated here for the lines on its card and preview.
  run('cargo', ['build', '--release', '--manifest-path', at('engine/Cargo.toml'), '-p', 'replay-sim']);
  const simulator = at(`engine/target/release/replay-sim${process.platform === 'win32' ? '.exe' : ''}`);
  const troops = (replay) => {
    try {
      const output = execFileSync(simulator, [replay, '--format', 'troops', '-o', '-', ...(gameMaps ? ['--game-dir', gameMaps] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return JSON.parse(output).strength.map((side) => reduceTroops(side));
    } catch (error) {
      console.warn(`No troop lines for ${path.basename(replay)}: ${String(error.stderr || error.message).trim()}`);
      return null;
    }
  };
  publishTournaments(tournaments, path.join(site, 'tournaments'), troops);
}
else {
  fs.mkdirSync(path.join(site, 'tournaments'), { recursive: true });
  fs.writeFileSync(path.join(site, 'tournaments/index.json'), '[]');
}
const previews = await writeLinkPreviews(site);
console.log(`Wrote ${previews.pages} link previews and ${previews.cards} cards`);
// Pages are served at their paths by the share worker. Should a path reach GitHub
// Pages instead, it opens the same page by its earlier #/ address.
fs.writeFileSync(path.join(site, '404.html'), `<!doctype html><meta charset="utf-8"><title>War of Dots Replays</title>
<script>const [, folder, ...rest] = location.pathname.split("/"); location.replace("/" + folder + "/#/" + rest.join("/") + location.search);</script>
`);

const git = parameters => execFileSync('git', parameters, { cwd: project, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(site, 'version.json'), JSON.stringify({
  version: fs.readFileSync(at('VERSION'), 'utf8').trim(),
  commit: git(['rev-parse', 'HEAD']),
}));
// Folders that start with an underscore must be served as they are.
fs.writeFileSync(path.join(site, '.nojekyll'), '');
console.log(`Built ${site}`);
