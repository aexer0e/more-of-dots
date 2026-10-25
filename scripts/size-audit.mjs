// Records the size of the staged engine, the app executable and its installers
// in build/size-audit.json after `npm run build`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const executable = process.platform === "win32" ? ".exe" : "";

function size(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.size;
  return fs.readdirSync(target).reduce((total, name) => total + size(path.join(target, name)), 0);
}

function entry(kind, target) {
  if (!target || !fs.existsSync(target)) return { kind, path: target ?? "", exists: false, bytes: null, mb: null };
  const bytes = size(target);
  return { kind, path: path.resolve(target), exists: true, bytes, mb: Math.round((bytes / 2 ** 20) * 100) / 100 };
}

function newest(directory, matches) {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory)
    .filter(matches)
    .map((name) => path.join(directory, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

// Cargo uses target/<triple>/release when an explicit target is selected, so
// every release folder is considered and the newest executable wins.
const targetRoot = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(root, "src-tauri", "target");
const releaseDirectories = [path.join(targetRoot, "release")];
if (fs.existsSync(targetRoot)) {
  for (const child of fs.readdirSync(targetRoot, { withFileTypes: true })) {
    if (child.isDirectory()) releaseDirectories.push(path.join(targetRoot, child.name, "release"));
  }
}
const app = releaseDirectories
  .map((directory) => path.join(directory, `more-of-dots${executable}`))
  .filter((file) => fs.existsSync(file))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!app) throw new Error("The build produced no More of Dots executable to audit.");
const bundle = path.join(path.dirname(app), "bundle");

const entries = [
  entry("replay-engine", path.join(root, "src-tauri", "resources", "player", `ReplaySim.Standalone${executable}`)),
  entry("tauri-exe", app),
  entry("nsis-installer", newest(path.join(bundle, "nsis"), (name) => name.includes(version) && name.endsWith(".exe"))),
  entry("macos-app", newest(path.join(bundle, "macos"), (name) => name.endsWith(".app"))),
  entry("dmg", newest(path.join(bundle, "dmg"), (name) => name.includes(version) && name.endsWith(".dmg"))),
  entry("appimage", newest(path.join(bundle, "appimage"), (name) => name.includes(version) && name.endsWith(".AppImage"))),
].filter((item) => item.exists || item.kind === "replay-engine" || item.kind === "tauri-exe");

const auditPath = path.join(root, "build", "size-audit.json");
fs.mkdirSync(path.dirname(auditPath), { recursive: true });
fs.writeFileSync(auditPath, `${JSON.stringify({ generated_at_utc: new Date().toISOString(), entries }, null, 2)}\n`);
console.log("Size audit:");
console.table(entries.map(({ kind, mb, exists, path: file }) => ({ kind, mb, exists, path: file })));
console.log(`Wrote ${auditPath}`);
