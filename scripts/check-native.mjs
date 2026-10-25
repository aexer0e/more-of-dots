// Runs the Rust library tests. Windows test executables need a manifest for the
// native dialog imports, which check-native.ps1 adds before running them.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nasmEnvironment } from "./nasm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, args] = process.platform === "win32"
  ? ["powershell.exe", ["-NoProfile", "-File", path.join(root, "scripts", "check-native.ps1")]]
  : ["cargo", ["test", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "--lib"]];
const result = spawnSync(command, args, { cwd: root, env: nasmEnvironment(), stdio: "inherit" });
process.exit(result.status ?? 1);
