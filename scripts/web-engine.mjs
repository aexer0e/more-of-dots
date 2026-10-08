// Runs the WebAssembly replay engine under Node, for parity checks against the
// desktop engine: node scripts/web-engine.mjs <engine dir> <input.rep> <output.repsim>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [engineDir, input, output] = process.argv.slice(2);
if (!output) { console.error('Usage: node scripts/web-engine.mjs <engine dir> <input.rep> <output.repsim>'); process.exit(2); }
const maps = path.resolve(import.meta.dirname, '../engine/repsim/maps');
const { dotnet } = await import(pathToFileURL(path.resolve(engineDir, '_framework/dotnet.js')).href);
const { setModuleImports, getAssemblyExports, getConfig } = await dotnet.create();
const sink = fs.openSync(output, 'w');
setModuleImports('replay-host', { write: view => fs.writeSync(sink, view.slice()) });
const engine = (await getAssemblyExports(getConfig().mainAssemblyName)).ReplaySim.Standalone.WebEngine;
const replay = fs.readFileSync(input);
const started = performance.now();
for (let missing; (missing = engine.Open(replay)) !== null;) {
  const file = [missing, path.basename(missing)].map(name => path.join(maps, name)).find(name => fs.existsSync(name));
  if (!file) throw new Error(`No bundled map for ${missing}`);
  engine.AddMap(missing, fs.readFileSync(file));
}
engine.Run();
fs.closeSync(sink);
console.log(`${Math.round(performance.now() - started)} ms`);
process.exit(0);
