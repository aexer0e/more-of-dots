// Runs the WebAssembly replay engine under Node, for parity checks against the
// desktop engine: node scripts/web-engine.mjs <replay-sim.wasm> <input.rep> <output.repsim>
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine } from '../src/player/wasm-engine.js';

const [wasm, input, output] = process.argv.slice(2);
if (!output) { console.error('Usage: node scripts/web-engine.mjs <replay-sim.wasm> <input.rep> <output.repsim>'); process.exit(2); }
const maps = path.resolve(import.meta.dirname, '../engine/maps');
const sink = fs.openSync(output, 'w');
const engine = await loadEngine(fs.readFileSync(wasm), bytes => fs.writeSync(sink, bytes));
const replay = fs.readFileSync(input);
const started = performance.now();
for (let missing; (missing = engine.open(replay)) !== null;) {
  const file = [missing, path.basename(missing)].map(name => path.join(maps, name)).find(name => fs.existsSync(name));
  if (!file) throw new Error(`No bundled map for ${missing}`);
  engine.addMap(missing, fs.readFileSync(file));
}
engine.run(true);
fs.closeSync(sink);
console.log(`${Math.round(performance.now() - started)} ms`);
