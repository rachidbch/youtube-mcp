// scripts/check-release.mjs: package, lockfile and Registry metadata must agree.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const checker = resolve("scripts/check-release.mjs");
const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "youtube-mcp-release-contract-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "docs"));

  const packageVersion = options.packageVersion ?? "1.2.3";
  const mcpName = options.mcpName ?? "io.github.granitebps/youtube-mcp";
  const lockName = options.lockName ?? "@granitebps/youtube-mcp";
  const lockVersion = options.lockVersion ?? packageVersion;
  const serverVersion = options.serverVersion ?? packageVersion;
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@granitebps/youtube-mcp", version: packageVersion, mcpName }));
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ name: lockName, version: lockVersion, packages: { "": { name: lockName, version: lockVersion } } }),
  );
  writeFileSync(
    join(root, "server.json"),
    JSON.stringify({
      name: options.serverName ?? mcpName,
      version: serverVersion,
      packages: [
        {
          registryType: "npm",
          identifier: options.packageIdentifier ?? "@granitebps/youtube-mcp",
          version: serverVersion,
          transport: { type: options.transportType ?? "stdio" },
        },
      ],
    }),
  );
  return root;
}

function run(root, tag, extraEnv = {}) {
  const args = [checker, "--root", root];
  if (tag) args.push("--tag", tag);
  const env = { ...process.env, ...extraEnv };
  if (!("GITHUB_REF" in extraEnv)) {
    delete env.GITHUB_REF;
    delete env.GITHUB_REF_NAME;
    delete env.GITHUB_REF_TYPE;
  }
  return spawnSync(process.execPath, args, { encoding: "utf8", env });
}

test("accepts synchronized package and Registry metadata", () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@granitebps\/youtube-mcp@1\.2\.3/);
});

test("ambient GitHub tag metadata applies when no --tag is given", () => {
  const result = run(fixture(), undefined, { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.0.1", GITHUB_REF: "refs/tags/v1.0.1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tag v1\.0\.1 does not match package version 1\.2\.3/);
});

for (const [options, expectedError] of [
  [{ lockVersion: "1.2.2" }, "package-lock.json root version"],
  [{ lockName: "@example/wrong" }, "package-lock.json root name"],
  [{ serverVersion: "1.2.2" }, "server.json version"],
  [{ serverName: "io.github.example/wrong" }, "server.json name"],
  [{ packageIdentifier: "@example/wrong" }, "npm package identifier"],
  [{ transportType: "streamable-http" }, "npm package transport"],
]) {
  test(`rejects inconsistent metadata: ${expectedError}`, () => {
    const result = run(fixture(options));
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(expectedError.replaceAll(".", "\\.")));
  });
}

test("requires matching version-specific notes for a release tag", () => {
  const root = fixture();
  const missing = run(root, "v1.2.3");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /docs\/release-notes-v1\.2\.3\.md/);

  writeFileSync(join(root, "docs", "release-notes-v1.2.3.md"), "# YouTube MCP v1.2.3\n");
  assert.equal(run(root, "v1.2.3").status, 0);
});

test("rejects a tag that differs from the package version", () => {
  const root = fixture();
  writeFileSync(join(root, "docs", "release-notes-v1.2.4.md"), "# YouTube MCP v1.2.4\n");
  const result = run(root, "v1.2.4");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tag v1\.2\.4 does not match package version 1\.2\.3/);
});

test("the repository's own metadata is consistent", () => {
  const result = run(resolve("."));
  assert.equal(result.status, 0, result.stderr);
});
