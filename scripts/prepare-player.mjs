// Stages the independent replay engine and its resources in src-tauri/resources/player
// for the current platform, with a SHA-256 manifest of everything staged.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "src-tauri", "resources", "player");
const windows = process.platform === "win32";

// The engine is built for the machine that builds the app.
function checkPlatform() {
  const arch = { x64: "x64", arm64: "arm64" }[process.arch];
  const platform = { win32: "win", darwin: "osx", linux: "linux" }[process.platform];
  if (!arch || !platform) throw new Error(`The replay engine is not built for ${process.platform} ${process.arch}.`);
  if (platform === "osx" && arch !== "arm64") throw new Error("More of Dots for macOS is built for Apple silicon only.");
  return `${platform}-${arch}`;
}

function run(command, args, failure) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(failure);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function stagedFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => path.basename(file) !== "manifest.json")
    .sort();
}

// Files from earlier builds (the .NET engine, the SDL renderer, FFmpeg, bundled audio) must not linger.
checkPlatform();
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });

const engine = path.join(root, "engine");
run("cargo", ["build", "--release", "--quiet", "--manifest-path", path.join(engine, "Cargo.toml"), "-p", "replay-sim"], "Independent replay engine compilation failed.");
const executable = `replay-sim${windows ? ".exe" : ""}`;
fs.copyFileSync(path.join(engine, "target", "release", executable), path.join(destination, executable));
if (!windows) fs.chmodSync(path.join(destination, executable), 0o755);
// Maps for replays that only name an official map; the game's own images take precedence.
fs.cpSync(path.join(engine, "maps"), path.join(destination, "maps"), {
  recursive: true, filter: (source) => fs.statSync(source).isDirectory() || source.endsWith(".png"),
});

if (windows) {
  // Region selection loads this probe into the running game, which only works on Windows.
  const probe = path.join(root, "tools", "python-probe-dll");
  run("cargo", ["build", "--release", "--quiet", "--manifest-path", path.join(probe, "Cargo.toml")], "Region probe compilation failed.");
  fs.copyFileSync(path.join(probe, "target", "release", "wod_python_probe.dll"), path.join(destination, "wod_python_probe.dll"));
}

// The video converter draws with the same unit artwork as the player.
const artwork = path.join(destination, "player-assets");
fs.mkdirSync(artwork, { recursive: true });
for (const file of fs.readdirSync(path.join(root, "public", "player-assets"))) {
  if (file.endsWith(".png")) fs.copyFileSync(path.join(root, "public", "player-assets", file), path.join(artwork, file));
}
fs.cpSync(path.join(root, "notices"), path.join(destination, "notices"), { recursive: true });

const files = stagedFiles(destination).map((file) => ({
  path: path.relative(destination, file).split(path.sep).join("/"),
  sha256: sha256(file),
}));
fs.writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify({ engine: "independent-replay-sim-v1", files }, null, 2)}\n`);
console.log(`Staged ${files.length} files for ${checkPlatform()} in ${path.relative(root, destination)}`);
