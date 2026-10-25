// Downloads the installers the Build workflow made for the current commit into
// build/installers/<commit>. macOS and Linux installers cannot be built on
// Windows, so they come from CI. If no build of this commit exists yet, one is
// started; the script waits for it. Needs the GitHub CLI (`gh`), signed in.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = "build.yml";

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: quiet ? "pipe" : ["ignore", "pipe", "inherit"] });
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed.${quiet && result.stderr ? `\n${result.stderr.trim()}` : ""}`);
  return result.stdout.trim();
}

const watch = (id) => spawnSync("gh", ["run", "watch", String(id), "--exit-status", "--interval", "30"], { cwd: root, stdio: "inherit" }).status === 0;
const runsFor = (branch, commit) =>
  JSON.parse(run("gh", ["run", "list", "--workflow", WORKFLOW, "--branch", branch, "--limit", "30", "--json", "databaseId,headSha,status,conclusion,url"], { quiet: true }))
    .filter((item) => item.headSha === commit);

const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const commit = run("git", ["rev-parse", "HEAD"]);
if (run("git", ["status", "--porcelain", "--untracked-files=no"])) console.warn("Uncommitted changes are not in the CI build.");
const pushed = spawnSync("git", ["rev-parse", `origin/${branch}`], { cwd: root, encoding: "utf8" }).stdout.trim();
if (pushed !== commit) throw new Error(`Push ${branch} first: CI builds the pushed commit, and origin/${branch} is not ${commit.slice(0, 7)}.`);

// A finished build is reused, even one where a platform failed: the others still have installers.
const runs = runsFor(branch, commit);
let build = runs.find((item) => item.conclusion === "success") ?? runs.find((item) => item.status !== "completed")
  ?? runs.find((item) => item.conclusion === "failure");
if (!build) {
  console.log(`Starting a build of ${branch} at ${commit.slice(0, 7)}.`);
  run("gh", ["workflow", "run", WORKFLOW, "--ref", branch]);
  for (let attempt = 0; attempt < 30 && !build; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    build = runsFor(branch, commit).find((item) => item.status !== "completed");
  }
  if (!build) throw new Error("The build did not appear. Check the Actions tab on GitHub.");
}
if (build.status !== "completed") {
  console.log(`Waiting for ${build.url} (about half an hour).`);
  watch(build.databaseId);
}
const failed = JSON.parse(run("gh", ["run", "view", String(build.databaseId), "--json", "jobs"], { quiet: true })).jobs
  .filter((job) => job.conclusion !== "success").map((job) => job.name);
if (failed.length) console.warn(`No installer from ${failed.join(", ")}: the build failed there. See ${build.url}`);

const destination = path.join(root, "build", "installers", commit.slice(0, 7));
fs.rmSync(destination, { recursive: true, force: true });
const downloaded = spawnSync("gh", ["run", "download", String(build.databaseId), "--dir", destination], { cwd: root, stdio: "inherit" });
if (downloaded.status !== 0 || !fs.existsSync(destination)) throw new Error(`The build has no installers to download: ${build.url}`);
console.log(`Installers for ${commit.slice(0, 7)}:`);
for (const entry of fs.readdirSync(destination, { recursive: true, withFileTypes: true })) {
  if (entry.isFile()) console.log(`  ${path.relative(root, path.join(entry.parentPath, entry.name))}`);
}
