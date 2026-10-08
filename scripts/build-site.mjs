// Builds the hosted replay player into build/site: the player page, the
// WebAssembly engine compiled from engine/repsim, and the official maps.
//   node scripts/build-site.mjs [--audio <folder>] [--skip-engine]
// --audio copies the site's sound files, which are kept outside this repository.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const at = (...parts) => path.join(project, ...parts);
const args = process.argv.slice(2);
const audio = args.includes('--audio') ? path.resolve(args[args.indexOf('--audio') + 1]) : null;
const run = (command, parameters) => execFileSync(command, parameters, { cwd: project, stdio: 'inherit' });

const engine = at('build/wasm-engine');
if (!args.includes('--skip-engine')) {
  fs.rmSync(engine, { recursive: true, force: true });
  run(process.env.DOTNET || 'dotnet', ['publish', at('engine/web/ReplaySim.Web.csproj'), '-c', 'Release', '-o', engine]);
}

const site = at('build/site');
run(process.execPath, [at('node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.site.config.ts']);
fs.renameSync(path.join(site, 'site.html'), path.join(site, 'index.html'));

// GitHub Pages compresses responses itself.
fs.cpSync(path.join(engine, 'wwwroot/_framework'), path.join(site, 'engine/_framework'), {
  recursive: true, filter: source => !/\.(br|gz)$/.test(source),
});
// Web addresses are case-sensitive; replays name maps in lower case.
const maps = at('engine/repsim/maps');
for (const file of fs.readdirSync(maps, { recursive: true }).filter(name => name.endsWith('.png'))) {
  const target = path.join(site, 'maps', file.toLowerCase());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(maps, file), target);
}
if (audio) fs.cpSync(audio, path.join(site, 'audio'), { recursive: true });

const git = parameters => execFileSync('git', parameters, { cwd: project, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(site, 'version.json'), JSON.stringify({
  version: fs.readFileSync(at('VERSION'), 'utf8').trim(),
  commit: git(['rev-parse', 'HEAD']),
}));
// Folders that start with an underscore must be served as they are.
fs.writeFileSync(path.join(site, '.nojekyll'), '');
console.log(`Built ${site}`);
