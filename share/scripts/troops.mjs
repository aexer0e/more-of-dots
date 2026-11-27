// Fills in the troop lines of shared replays that have none, so visitors never
// simulate a replay for its card. Each replay is simulated with the engine's own
// command line, as the site build does for tournament replays. A replay that cannot be
// simulated is kept with no lines ([]), so it is not tried again.
//   node scripts/troops.mjs --local | --remote
// Replays are downloaded from the worker at API (the live one unless set). Build the
// engine first (cargo build --release --manifest-path engine/Cargo.toml -p replay-sim);
// set WOD_GAME_DIR to the game's folder, or to a built site's maps/ folder, for maps
// the engine does not bundle.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reduceTroops } from "../../src/replays/troop-lines.ts";
import { troopsOf } from "../src/listing.js";

const target = process.argv.includes("--remote") ? "--remote" : process.argv.includes("--local") ? "--local" : null;
if (!target) throw new Error("Say --local or --remote.");
const API = process.env.API ?? "https://wod-replays.moreofdots.workers.dev";
const share = path.resolve(import.meta.dirname, "..");
const simulator = path.resolve(share, `../engine/target/release/replay-sim${process.platform === "win32" ? ".exe" : ""}`);
if (!fs.existsSync(simulator)) throw new Error(`Build the engine first: ${simulator} is missing.`);
const gameDir = process.env.WOD_GAME_DIR ? ["--game-dir", process.env.WOD_GAME_DIR] : [];
const wrangler = (...args) =>
  execFileSync(process.execPath, [path.join(share, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "wod-replays", target, ...args],
    { cwd: share, encoding: "utf8", maxBuffer: 64 << 20 });

const [{ results }] = JSON.parse(wrangler("--json", "--command", "SELECT id FROM replays WHERE troops IS NULL"));
console.log(`${results.length} replays without lines.`);
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "troops-"));
let statements = [];
let drawn = 0,
  done = 0;
// Lines are written 50 replays at a time, so a stopped run keeps what it did.
const write = () => {
  if (!statements.length) return;
  const file = path.join(folder, "troops.sql");
  fs.writeFileSync(file, statements.join("\n"));
  wrangler("--yes", "--file", file);
  done += statements.length;
  statements = [];
};
const download = async (id) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(`${API}/replays/${id}`);
    } catch (error) {
      if (attempt === 3) return { ok: false, status: error.message };
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
};
for (const { id } of results) {
  const response = await download(id);
  if (!response.ok) {
    console.log(`${id}: ${response.status}`);
    continue;
  }
  const file = path.join(folder, `${id}.rep`);
  fs.writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
  let troops = "[]";
  try {
    const output = execFileSync(simulator, [file, "--format", "troops", "-o", "-", ...gameDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    troops = troopsOf(JSON.parse(output).strength.map((side) => reduceTroops(side))) ?? "[]";
    drawn += troops !== "[]";
  } catch (error) {
    console.log(`${id}: ${String(error.stderr || error.message).trim().split("\n")[0]}`);
  }
  fs.rmSync(file);
  statements.push(`UPDATE replays SET troops = '${troops}' WHERE id = '${id}';`);
  if (statements.length === 50) write();
}
write();
fs.rmSync(folder, { recursive: true, force: true });
console.log(`Drew lines for ${drawn} of ${done} replays.`);
