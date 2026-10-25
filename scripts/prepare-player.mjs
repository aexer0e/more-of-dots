// Stages the independent replay engine and its resources in src-tauri/resources/player
// for the current platform, with a SHA-256 manifest of everything staged.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "src-tauri", "resources", "player");
const windows = process.platform === "win32";

// The engine is self-contained, so it is published for the machine that builds the app.
function runtimeIdentifier() {
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

// DOTNET names a specific dotnet executable. Otherwise the first one with an SDK:
// the dotnet on PATH may be a runtime-only install, and dotnet-install puts the SDK
// in the user profile without adding it to PATH.
function findDotnet() {
  if (process.env.DOTNET) return process.env.DOTNET;
  const candidates = ["dotnet", path.join(os.homedir(), ".dotnet", windows ? "dotnet.exe" : "dotnet")];
  for (const candidate of candidates) {
    const sdks = spawnSync(candidate, ["--list-sdks"], { encoding: "utf8" });
    if (!sdks.error && sdks.status === 0 && sdks.stdout.trim()) return candidate;
  }
  throw new Error("No .NET SDK found. Install the .NET 9 SDK, or set DOTNET to its dotnet executable.");
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

// Files from earlier builds (the SDL renderer, FFmpeg, bundled audio) must not linger.
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });

run(findDotnet(), [
  "publish", path.join(root, "engine", "repsim", "ReplaySim.Standalone.csproj"),
  "-c", "Release", "-r", runtimeIdentifier(), "--self-contained", "true",
  "-p:PublishSingleFile=true", "-p:DebugType=None", "-o", destination,
], "Independent replay engine compilation failed.");
// Native libraries can bring their debug symbols along.
for (const file of stagedFiles(destination)) if (file.endsWith(".pdb")) fs.rmSync(file);

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
fs.writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify({ engine: "independent-repsim-v1", files }, null, 2)}\n`);
console.log(`Staged ${files.length} files for ${runtimeIdentifier()} in ${path.relative(root, destination)}`);
