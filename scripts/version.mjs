import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

export const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = path.join(rootDir, "VERSION");
const generatedConfigPath = path.join(rootDir, "build", "tauri.version.conf.json");

export function parseVersion(value) {
  const version = String(value).trim();
  const match = STABLE_SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(`VERSION must contain one stable SemVer value in X.Y.Z form; received ${JSON.stringify(version)}.`);
  }
  return {
    value: version,
    parts: match.slice(1).map(Number),
  };
}

export function compareVersions(left, right) {
  const leftParts = typeof left === "string" ? parseVersion(left).parts : left.parts;
  const rightParts = typeof right === "string" ? parseVersion(right).parts : right.parts;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function readVersion(filePath = versionPath) {
  return parseVersion(fs.readFileSync(filePath, "utf8"));
}

export function createTauriVersionConfig(version, { release = false } = {}) {
  const config = { version: parseVersion(version).value };
  if (release) config.bundle = { createUpdaterArtifacts: true };
  return config;
}

export function writeTauriVersionConfig({ release = false } = {}) {
  const version = readVersion().value;
  const config = createTauriVersionConfig(version, { release });
  fs.mkdirSync(path.dirname(generatedConfigPath), { recursive: true });
  fs.writeFileSync(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { version, configPath: generatedConfigPath };
}

function stableVersionTags() {
  const output = execFileSync("git", ["tag", "--list", "v*"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((tag) => {
      try {
        return [{ tag, version: parseVersion(tag.slice(1)) }];
      } catch {
        return [];
      }
    });
}

export function validateVersionProgression(currentValue, tagNames, { existingTagMatchesHead = false } = {}) {
  const current = parseVersion(currentValue);
  const tag = `v${current.value}`;
  const tags = tagNames.flatMap((tagName) => {
    try {
      return [{ tag: tagName, version: parseVersion(tagName.slice(1)) }];
    } catch {
      return [];
    }
  });
  const existing = tags.find((candidate) => candidate.tag === tag);
  if (existing) {
    if (!existingTagMatchesHead) throw new Error(`${tag} already exists for another release commit.`);
    return { version: current.value, tag, existingTag: true };
  }
  const latest = tags.sort((left, right) => compareVersions(right.version, left.version))[0];
  if (latest && compareVersions(current, latest.version) <= 0) {
    throw new Error(`VERSION ${current.value} must be greater than the latest stable tag ${latest.tag}.`);
  }
  return { version: current.value, tag, existingTag: false, latestTag: latest?.tag ?? null };
}

export function validateReleaseVersion({ head = "HEAD" } = {}) {
  const current = readVersion();
  const tag = `v${current.value}`;
  const tags = stableVersionTags();
  const existing = tags.find((candidate) => candidate.tag === tag);

  if (existing) {
    const tagCommit = execFileSync("git", ["rev-list", "-n", "1", tag], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    const headCommit = execFileSync("git", ["rev-parse", head], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    if (tagCommit !== headCommit) {
      throw new Error(`${tag} already points to ${tagCommit}, not the release commit ${headCommit}.`);
    }
    return validateVersionProgression(current.value, tags.map((candidate) => candidate.tag), { existingTagMatchesHead: true });
  }
  return validateVersionProgression(current.value, tags.map((candidate) => candidate.tag));
}

function runTauri(args) {
  if (!args.length || !["dev", "build"].includes(args[0])) {
    throw new Error("Usage: node scripts/version.mjs tauri <dev|build> [Tauri arguments]");
  }
  const { configPath } = writeTauriVersionConfig();
  const tauriCliPath = path.join(rootDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
  if (!fs.existsSync(tauriCliPath)) {
    throw new Error("The local Tauri CLI is missing. Run npm ci before starting or building the app.");
  }
  const result = spawnSync(process.execPath, [tauriCliPath, ...args, "--config", configPath], {
    cwd: rootDir,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "config") {
    const result = writeTauriVersionConfig({ release: args.includes("--release") });
    process.stdout.write(`${result.configPath}\n`);
    return;
  }
  if (command === "release-check") {
    process.stdout.write(`${JSON.stringify(validateReleaseVersion())}\n`);
    return;
  }
  if (command === "tauri") {
    runTauri(args);
    return;
  }
  throw new Error("Usage: node scripts/version.mjs <config [--release]|release-check|tauri <dev|build>>");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
