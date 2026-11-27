// Fills in what the list of shared replays sorts and filters by (src/listing.js)
// for replays shared before the worker read it: players, length, version, match
// format, the kind of map and the map's key. Map pictures are read by the worker the first time
// one is asked for, since D1 does not take statements that long.
//   node scripts/describe.mjs --local | --remote
// Replays are downloaded from the worker at API (the live one unless set).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replayText } from "../src/replay.js";
import { columns } from "../src/listing.js";

const target = process.argv.includes("--remote") ? "--remote" : process.argv.includes("--local") ? "--local" : null;
if (!target) throw new Error("Say --local or --remote.");
const API = process.env.API ?? "https://wod-replays.moreofdots.workers.dev";
const share = path.resolve(import.meta.dirname, "..");
const wrangler = (...args) =>
  execFileSync(process.execPath, [path.join(share, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "wod-replays", target, ...args],
    { cwd: share, encoding: "utf8", maxBuffer: 64 << 20 });

const [{ results }] = JSON.parse(wrangler("--json", "--command", "SELECT id FROM replays WHERE mode IS NULL OR map_key IS NULL"));
console.log(`${results.length} replays to describe.`);
const quote = (value) => (value === null || value === undefined ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`);
const statements = [];
for (const { id } of results) {
  const response = await fetch(`${API}/replays/${id}`);
  if (!response.ok) {
    console.log(`${id}: ${response.status}`);
    continue;
  }
  const c = await columns(await replayText(new Uint8Array(await response.arrayBuffer())));
  statements.push(`UPDATE replays SET players = ${quote(c.players)}, frames = ${quote(c.frames)}, version = ${quote(c.version)}, mode = ${quote(c.mode)}, custom = ${c.custom}, map = ${quote(c.map)}, map_key = ${quote(c.mapKey)} WHERE id = '${id}';`);
}
if (statements.length) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "describe-")), "describe.sql");
  fs.writeFileSync(file, statements.join("\n"));
  wrangler("--yes", "--file", file);
}
console.log(`Described ${statements.length} replays.`);
