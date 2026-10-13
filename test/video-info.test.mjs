// Offline: get_video_info classification with a fake fetch behind youtubei.js.
// youtubei.js falls back to a locally generated session when its bootstrap
// requests fail, so failing sw.js_data/config lets the client initialize offline.
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VIDEO_ID, installFakeFetch, json, status, callTool } from "./helpers.mjs";
import { errOf } from "./helpers.mjs";

const { getVideoInfo, getVideoInfoOutputSchema } = await import("../dist/tools/get-video-info.js");
const { resetForTesting } = await import("../dist/utils/youtube-api.js");
const { z } = await import("zod");
const output = z.object(getVideoInfoOutputSchema).strict();

let fake;
beforeEach(() => resetForTesting({ retrievePlayer: false }));
afterEach(() => fake?.restore());

function routes({ player, next = json({}), bootstrap = status(500) } = {}) {
  return [
    [/sw\.js_data/, bootstrap],
    [/youtubei\/v1\/config/, bootstrap],
    [/youtubei\/v1\/player/, player],
    [/youtubei\/v1\/next/, next],
  ];
}

const videoDetails = (over = {}) => ({
  videoId: VIDEO_ID,
  title: "A title",
  lengthSeconds: "81",
  channelId: "UCchannel",
  shortDescription: "Desc",
  author: "Some Channel",
  viewCount: "404704",
  keywords: ["a", "b"],
  thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/x/default.jpg", width: 120, height: 90 }] },
  ...over,
});

test("returns metadata with numeric duration and explicit unknowns", async () => {
  fake = installFakeFetch(routes({ player: json({ playabilityStatus: { status: "OK" }, videoDetails: videoDetails() }) }));
  const r = await callTool(getVideoInfo, { video: `https://www.youtube.com/watch?v=${VIDEO_ID}` });
  assert.ok(!r.isError, JSON.stringify(r));
  const sc = output.parse(r.structuredContent);
  assert.equal(sc.videoId, VIDEO_ID);
  assert.equal(sc.title, "A title");
  assert.equal(sc.channelName, "Some Channel");
  assert.equal(sc.channelId, "UCchannel");
  assert.equal(sc.description, "Desc");
  assert.equal(sc.durationSeconds, 81);
  assert.equal(sc.duration, "1m 21s");
  assert.equal(sc.viewCount, "404704");
  // not present in the fake /next response: unknown, not "0" or "N/A"
  assert.equal(sc.likeCount, null);
  assert.equal(sc.commentCount, null);
  assert.equal(sc.uploadedAt, null);
  // metadata needs only player + next; no player script or format requests
  assert.ok(!fake.calls.some((c) => /base\.js|iframe_api|videoplayback/.test(c.url)));
});

test("live/zero duration is null, not 0s", async () => {
  fake = installFakeFetch(routes({ player: json({ playabilityStatus: { status: "OK" }, videoDetails: videoDetails({ lengthSeconds: "0", isLive: true }) }) }));
  const sc = output.parse((await callTool(getVideoInfo, { video: VIDEO_ID })).structuredContent);
  assert.equal(sc.durationSeconds, null);
  assert.equal(sc.duration, null);
});

for (const [st, reason, code, kind] of [
  ["LOGIN_REQUIRED", "Sign in to confirm you’re not a bot", "ACCESS_BLOCKED", "login_required"],
  ["LOGIN_REQUIRED", "This video is private", "VIDEO_UNAVAILABLE", undefined],
  ["ERROR", "Video unavailable", "VIDEO_UNAVAILABLE", undefined],
  ["UNPLAYABLE", "This video is not available", "VIDEO_UNAVAILABLE", undefined],
]) {
  test(`no videoDetails + ${st} "${reason}" → ${code}`, async () => {
    fake = installFakeFetch(routes({ player: json({ playabilityStatus: { status: st, reason } }) }));
    const r = await callTool(getVideoInfo, { video: VIDEO_ID });
    assert.equal(r.isError, true);
    const e = errOf(r);
    assert.equal(e.code, code);
    assert.equal(e.upstream.playabilityStatus, st);
    assert.equal(e.upstream.reason, reason);
    if (kind) assert.equal(e.upstream.accessKind, kind);
    assert.doesNotMatch(r.content[0].text, /Video not found/);
  });
}

test("metadata is still returned when playback is refused but details exist", async () => {
  fake = installFakeFetch(routes({ player: json({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" }, videoDetails: videoDetails() }) }));
  const r = await callTool(getVideoInfo, { video: VIDEO_ID });
  assert.ok(!r.isError);
  assert.equal(r.structuredContent.title, "A title");
});

for (const code of [403, 429]) {
  test(`player HTTP ${code} → ACCESS_BLOCKED`, async () => {
    fake = installFakeFetch(routes({ player: status(code) }));
    const e = errOf(await callTool(getVideoInfo, { video: VIDEO_ID }));
    assert.equal(e.code, "ACCESS_BLOCKED");
    assert.equal(e.upstream.httpStatus, code);
  });
}

test("mismatched video ID is rejected", async () => {
  fake = installFakeFetch(routes({ player: json({ playabilityStatus: { status: "OK" }, videoDetails: videoDetails({ videoId: "BBBBBBBBBBB" }) }) }));
  const e = errOf(await callTool(getVideoInfo, { video: VIDEO_ID }));
  assert.equal(e.code, "PARSE_ERROR");
  assert.match(e.message, /BBBBBBBBBBB instead of AAAAAAAAAAA/);
});

test("OK playability but no title → PARSE_ERROR, not 'not found'", async () => {
  fake = installFakeFetch(routes({ player: json({ playabilityStatus: { status: "OK" } }) }));
  const e = errOf(await callTool(getVideoInfo, { video: VIDEO_ID }));
  assert.equal(e.code, "PARSE_ERROR");
});

test("malformed input → INVALID_INPUT with no requests", async () => {
  fake = installFakeFetch([]);
  const e = errOf(await callTool(getVideoInfo, { video: "https://vimeo.com/123" }));
  assert.equal(e.code, "INVALID_INPUT");
  assert.equal(fake.calls.length, 0);
});
