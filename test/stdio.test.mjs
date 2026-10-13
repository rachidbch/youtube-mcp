// Offline: real stdio subprocess. Initialize, discover tools, reject bad input, shut down cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { errOf } from "./helpers.mjs";

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("initialize, list tools, call with bad input, close → process exits by itself", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  let closed = false;
  try {
  assert.equal(client.getServerVersion().name, "youtube-mcp");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "get_transcript_languages", "get_video_comments", "get_video_info", "get_video_transcript", "search_youtube",
  ]);
  for (const t of tools) assert.ok(t.outputSchema, `${t.name} has outputSchema`);

  const r = await client.callTool({ name: "get_video_info", arguments: { video: "https://example.com/watch?v=C7OQHIpDlvA" } });
  assert.equal(r.isError, true);
  assert.equal(errOf(r).code, "INVALID_INPUT");

  const pid = transport.pid;
  const t = Date.now();
  await client.close();
  closed = true;
  // StdioClientTransport escalates to SIGTERM after 2s; exiting well before that means stdin close did it.
  assert.ok(Date.now() - t < 1500, `close took ${Date.now() - t}ms`);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "server process still alive");
  assert.match(stderr, /Shutting down \{"reason":"stdin closed"\}/);
  } finally {
    if (!closed) await client.close();
  }
});

test("stdout carries only JSON-RPC; logs go to stderr", async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await new Promise((r) => setTimeout(r, 500));
  const code = await new Promise((resolve) => { child.on("exit", resolve); child.stdin.end(); });
  assert.equal(code, 0);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, "2.0");
  assert.match(err, /running on stdio/);
});

test("invalid configuration fails fast with a clear stderr message", async () => {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, YT_REQUEST_TIMEOUT_MS: "soon" }, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(err, /Invalid YT_REQUEST_TIMEOUT_MS="soon"/);
});
