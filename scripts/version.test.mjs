import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, createTauriVersionConfig, parseVersion, validateVersionProgression } from "./version.mjs";

test("accepts stable semantic versions", () => {
  assert.deepEqual(parseVersion("1.0.0\n"), { value: "1.0.0", parts: [1, 0, 0] });
  assert.deepEqual(parseVersion("12.34.56"), { value: "12.34.56", parts: [12, 34, 56] });
});

test("rejects malformed and prerelease versions", () => {
  for (const value of ["1.0", "v1.0.0", "1.0.0-beta.1", "1.0.0+build", "01.0.0", "1.0.0 extra", ""]) {
    assert.throws(() => parseVersion(value), /stable SemVer/);
  }
});

test("compares release versions numerically", () => {
  assert.ok(compareVersions("1.0.1", "1.0.0") > 0);
  assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("1.0.0", "1.0.1") < 0);
});

test("enables updater artifacts only for release configs", () => {
  assert.deepEqual(createTauriVersionConfig("1.0.0"), { version: "1.0.0" });
  assert.deepEqual(createTauriVersionConfig("1.0.0", { release: true }), {
    version: "1.0.0",
    bundle: { createUpdaterArtifacts: true },
  });
});

test("rejects duplicate and non-increasing release versions", () => {
  assert.throws(() => validateVersionProgression("1.0.0", ["v1.0.0"]), /already exists/);
  assert.throws(() => validateVersionProgression("1.0.0", ["v1.1.0"]), /must be greater/);
  assert.deepEqual(validateVersionProgression("1.0.0", ["v1.0.0"], { existingTagMatchesHead: true }), {
    version: "1.0.0",
    tag: "v1.0.0",
    existingTag: true,
  });
  assert.deepEqual(validateVersionProgression("1.2.0", ["v1.1.0", "unrelated"]), {
    version: "1.2.0",
    tag: "v1.2.0",
    existingTag: false,
    latestTag: "v1.1.0",
  });
});
