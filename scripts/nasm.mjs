// OpenH264's x86 assembly needs NASM at build time. Its Windows installer does
// not add itself to PATH, so the usual install folders are checked too and the
// one found is handed to the build through NASM and PATH.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const works = (command) => {
  const result = spawnSync(command, ["-v"], { encoding: "utf8" });
  return !result.error && result.status === 0;
};

/** Environment for a Cargo build: NASM and PATH set when NASM was found off PATH. */
export function nasmEnvironment(environment = process.env) {
  if (environment.NASM || works("nasm") || process.arch !== "x64") return environment;
  const executable = process.platform === "win32" ? "nasm.exe" : "nasm";
  const folders = process.platform === "win32"
    ? [environment.ProgramFiles, environment["ProgramFiles(x86)"], environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "bin")]
        .filter(Boolean).map((root) => path.join(root, "NASM"))
    : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];
  const found = folders.map((folder) => path.join(folder, executable)).find((file) => fs.existsSync(file) && works(file));
  if (!found) return environment;
  const key = Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  return { ...environment, NASM: found, [key]: `${path.dirname(found)}${path.delimiter}${environment[key] ?? ""}` };
}
