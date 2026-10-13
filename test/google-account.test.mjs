// Offline: Google account playlist fetchers with a mocked fetch (no network).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.YT_GOOGLE_CLIENT_ID = "cid";
process.env.YT_GOOGLE_CLIENT_SECRET = "secret";
process.env.YT_GOOGLE_REFRESH_TOKEN = "rtok";

const { fetchMyPlaylists, fetchMyPlaylistVideos, resetAccountForTesting } = await import("../dist/utils/google-account.js");

let calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function route(url) {
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    return json({ access_token: "at", expires_in: 3600, refresh_token: "rtok" });
  }
  if (url.includes("/youtube/v3/playlists?")) {
    return json({
      items: [
        { id: "PL1", snippet: { title: "My private mix" }, status: { privacyStatus: "private" }, contentDetails: { itemCount: 12 } },
        { id: "PL2", snippet: { title: "Public stuff" }, status: { privacyStatus: "public" }, contentDetails: { itemCount: 3 } },
      ],
    });
  }
  if (url.includes("/youtube/v3/channels?")) {
    return json({ items: [{ contentDetails: { relatedPlaylists: { likes: "LLxyz", uploads: "UUxyz" } } }] });
  }
  if (url.includes("/youtube/v3/playlistItems?")) {
    const u = new URL(url);
    const token = u.searchParams.get("pageToken");
    if (!token) {
      return json({
        nextPageToken: "p2",
        items: [
          { snippet: { title: "First", position: 0, publishedAt: "2026-01-02T00:00:00Z", videoOwnerChannelTitle: "Chan A", resourceId: { videoId: "aaaaaaaaaaa" } } },
          { snippet: { title: "Private video", position: 1, resourceId: { videoId: "bbbbbbbbbbb" } } },
          { snippet: { title: "Deleted video", position: 2, resourceId: { videoId: "ccccccccccc" } } },
        ],
      });
    }
    return json({
      items: [
        { snippet: { title: "Second page item", position: 3, videoOwnerChannelTitle: "Chan B", resourceId: { videoId: "ddddddddddd" } } },
      ],
    });
  }
  throw new Error(`unexpected url ${url}`);
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  resetAccountForTesting();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return route(url);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  resetAccountForTesting();
});

test("fetchMyPlaylists merges special playlists first", async () => {
  const page = await fetchMyPlaylists(1);
  assert.deepEqual(page.playlists.map((p) => [p.kind, p.playlistId, p.title, p.videoCount, p.privacyStatus]), [
    ["liked", "LLxyz", "Liked videos", null, "private"],
    ["uploads", "UUxyz", "My uploads", null, "public"],
    ["created", "PL1", "My private mix", 12, "private"],
    ["created", "PL2", "Public stuff", 3, "public"],
  ]);
  assert.equal(page.hasMore, false);
  // token + playlists + channels = 3 calls
  assert.equal(calls.length, 3);
});

test("fetchMyPlaylistVideos filters dead entries; hasMore is exact", async () => {
  const p1 = await fetchMyPlaylistVideos("PL1", 2, 1);
  assert.deepEqual(p1.videos.map((v) => v.title), ["First", "Second page item"]); // dead entries skipped
  assert.equal(p1.hasMore, false); // only 2 live videos exist; both fit on page 1
  const p2 = await fetchMyPlaylistVideos("PL1", 2, 2);
  assert.equal(p2.videos.length, 0);
  assert.equal(p2.hasMore, false);
  assert.equal(p2.totalFetched, 0);
});

test("access token is reused across calls within its lifetime", async () => {
  await fetchMyPlaylists(1);
  await fetchMyPlaylistVideos("PL1", 5, 1);
  const tokenCalls = calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token")).length;
  assert.equal(tokenCalls, 1);
});

test("revoked refresh token maps to ACCESS_BLOCKED with re-login guidance", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(' {"error": "invalid_grant"} ', { status: 400 });
    }
    throw new Error("should not reach the API");
  };
  await assert.rejects(() => fetchMyPlaylists(1), (e) => {
    assert.equal(e.code, "ACCESS_BLOCKED");
    assert.match(e.message, /Re-run scripts\/google-oauth-login\.mjs/);
    return true;
  });
});

test("stale 401 refreshes once and retries the API call", async () => {
  let apiAttempts = 0;
  resetAccountForTesting();
  // seed a token so the first API attempt does not need the token endpoint
  await fetchMyPlaylists(1).catch(() => {});
  resetAccountForTesting();
  let first = true;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "fresh", expires_in: 3600 });
    if (url.includes("/youtube/v3/playlists?")) {
      apiAttempts++;
      if (first) {
        first = false;
        return json({ error: { code: 401, message: "Invalid Credentials" } }, 401);
      }
      return json({ items: [] });
    }
    if (url.includes("/youtube/v3/channels?")) return json({ items: [] });
    throw new Error(`unexpected ${url}`);
  };
  const page = await fetchMyPlaylists(1);
  assert.equal(page.playlists.length, 0);
  assert.equal(apiAttempts, 2);
});
