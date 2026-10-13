// scripts/check-workflows.mjs and scripts/npm-command.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { npmCommand } from "../../scripts/npm-command.mjs";

test("workflows enforce the release policy", () => {
  const result = spawnSync(process.execPath, [resolve("scripts/check-workflows.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Workflow policy verified/);
});

test("npm runs through Node instead of a platform-specific shim", () => {
  assert.deepEqual(npmCommand(["pack", "--json"], { npm_execpath: "C:\\node\\npm-cli.js" }), {
    command: process.execPath,
    args: ["C:\\node\\npm-cli.js", "pack", "--json"],
  });
});

test("npm execution outside an npm script is rejected", () => {
  assert.throws(() => npmCommand(["ci"], {}), /npm_execpath is required/);
});
