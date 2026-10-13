// scripts/check-registry-entry.mjs: a rerun accepts an existing Registry entry only if it matches exactly.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const checker = resolve("scripts/check-registry-entry.mjs");
const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function server(commit = "abc123") {
  return {
    $schema: "https://example.com/server.schema.json",
    name: "io.github.example/server",
    title: "Example",
    description: "Example server",
    repository: { url: "https://github.com/example/server", source: "github" },
    version: "1.2.3",
    packages: [{ registryType: "npm", identifier: "@example/server", version: "1.2.3", transport: { type: "stdio" } }],
    _meta: { "io.modelcontextprotocol.registry/publisher-provided": { buildInfo: { commit } } },
  };
}

function run(expected, actualServer, commit = "abc123") {
  const root = mkdtempSync(join(tmpdir(), "youtube-mcp-registry-entry-"));
  temporaryRoots.push(root);
  const expectedPath = join(root, "expected.json");
  const actualPath = join(root, "actual.json");
  writeFileSync(expectedPath, JSON.stringify(expected));
  writeFileSync(actualPath, JSON.stringify({ server: actualServer, _meta: { registry: true } }));
  return spawnSync(process.execPath, [checker, "--expected", expectedPath, "--actual", actualPath, "--commit", commit], {
    encoding: "utf8",
  });
}

test("accepts the exact published server document and commit", () => {
  const expected = server();
  const result = run(expected, structuredClone(expected));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Registry entry verified/);
});

for (const [label, mutate] of [
  ["description", (v) => (v.description = "Different")],
  ["repository", (v) => (v.repository.url += "-fork")],
  ["package", (v) => (v.packages[0].identifier = "@example/other")],
  ["commit", (v) => (v._meta["io.modelcontextprotocol.registry/publisher-provided"].buildInfo.commit = "wrong")],
]) {
  test(`rejects mismatched ${label}`, () => {
    const actual = server();
    mutate(actual);
    const result = run(server(), actual);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match/);
  });
}

test("rejects a publication document bound to another commit", () => {
  const result = run(server("abc123"), server("abc123"), "def456");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not contain the triggering commit/);
});
