// Offline: deadlines and MCP cancellation abort the underlying HTTP work,
// during client initialization and during requests, and leave nothing running.
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  VIDEO_ID, installFakeFetch, hang, json, status, text, WATCH_PAGE, callTool, activeHandlesSince,
} from "./helpers.mjs";
import { errOf } from "./helpers.mjs";

process.env.YT_INIT_TIMEOUT_MS = "150";
process.env.YT_REQUEST_TIMEOUT_MS = "300";

const { getVideoInfo } = await import("../dist/tools/get-video-info.js");
const { getTranscriptLanguages } = await import("../dist/tools/get-transcript-languages.js");
const { resetForTesting } = await import("../dist/utils/youtube-api.js");

let fake;
let baseline;
beforeEach(() => {
  resetForTesting({ retrievePlayer: false });
  baseline = process.getActiveResourcesInfo();
});
afterEach(() => fake?.restore());

async function assertNothingLeft() {
  await sleep(20); // let abort rejections settle
  assert.equal(fake.pending, 0, "fake fetches still pending");
  assert.deepEqual(activeHandlesSince(baseline), [], "timers/handles left behind");
}

const okPlayer = json({ playabilityStatus: { status: "OK" }, videoDetails: { videoId: VIDEO_ID, title: "t", author: "a", lengthSeconds: "5" } });

test("client init hanging past YT_INIT_TIMEOUT_MS → TIMEOUT, init aborted", async () => {
  fake = installFakeFetch([[/sw\.js_data|v1\/config/, hang()], [/v1\/player/, okPlayer], [/v1\/next/, json({})]]);
  const t = Date.now();
  const r = await callTool(getVideoInfo, { video: VIDEO_ID });
  assert.equal(errOf(r).code, "TIMEOUT");
  assert.match(errOf(r).message, /initialization timed out after 150ms/);
  assert.ok(Date.now() - t < 1000);
  // The aborted bootstrap must not have continued on to video requests.
  assert.ok(!fake.calls.some((c) => c.url.includes("/player")));
  await assertNothingLeft();
});

test("caller cancellation during init aborts init when no other caller waits", async () => {
  fake = installFakeFetch([[/sw\.js_data|v1\/config/, hang()], [/v1\/player/, okPlayer], [/v1\/next/, json({})]]);
  const ac = new AbortController();
  const p = callTool(getVideoInfo, { video: VIDEO_ID }, ac.signal);
  await sleep(30);
  ac.abort();
  const r = await p;
  assert.equal(errOf(r).code, "CANCELLED");
  await assertNothingLeft();
  assert.ok(!fake.calls.some((c) => c.url.includes("/player")));
});

test("init shared by two callers survives one caller cancelling", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  fake = installFakeFetch([
    [/sw\.js_data|v1\/config/, async () => { await gate; return new Response("", { status: 500 }); }],
    [/v1\/player/, okPlayer],
    [/v1\/next/, json({})],
  ]);
  const ac = new AbortController();
  const cancelled = callTool(getVideoInfo, { video: VIDEO_ID }, ac.signal);
  const survivor = callTool(getVideoInfo, { video: VIDEO_ID });
  await sleep(20);
  ac.abort();
  assert.equal(errOf(await cancelled).code, "CANCELLED");
  release();
  const r = await survivor;
  assert.ok(!r.isError, JSON.stringify(r.structuredContent));
  assert.equal(r.structuredContent.title, "t");
  await assertNothingLeft();
});

test("request hanging past YT_REQUEST_TIMEOUT_MS → TIMEOUT, fetch aborted", async () => {
  fake = installFakeFetch([[/sw\.js_data|v1\/config/, status(500)], [/v1\/player/, hang()], [/v1\/next/, hang()]]);
  const t = Date.now();
  const r = await callTool(getVideoInfo, { video: VIDEO_ID });
  assert.equal(errOf(r).code, "TIMEOUT");
  assert.ok(Date.now() - t < 1500);
  await assertNothingLeft();
});

test("MCP cancellation mid-request aborts the transcript fetch", async () => {
  fake = installFakeFetch([[/youtube\.com\/watch\?/, text(WATCH_PAGE)], [/v1\/player/, hang()]]);
  const ac = new AbortController();
  const p = callTool(getTranscriptLanguages, { video: VIDEO_ID }, ac.signal);
  await sleep(30);
  assert.equal(fake.pending, 1);
  ac.abort();
  const r = await p;
  assert.equal(errOf(r).code, "CANCELLED");
  await assertNothingLeft();
});

test("already-cancelled call makes no requests", async () => {
  fake = installFakeFetch([]);
  const ac = new AbortController();
  ac.abort();
  const r = await callTool(getTranscriptLanguages, { video: VIDEO_ID }, ac.signal);
  assert.equal(errOf(r).code, "CANCELLED");
  assert.equal(fake.calls.length, 0);
});

test("successful calls clear their deadline timers", async () => {
  fake = installFakeFetch([[/sw\.js_data|v1\/config/, status(500)], [/v1\/player/, okPlayer], [/v1\/next/, json({})]]);
  const r = await callTool(getVideoInfo, { video: VIDEO_ID });
  assert.ok(!r.isError);
  await assertNothingLeft();
});
