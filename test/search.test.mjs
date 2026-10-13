// Offline: search filter mapping, warnings for options YouTube cannot apply, and the output schema.
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VIDEO_ID, installFakeFetch, json, status, callTool } from "./helpers.mjs";

const { searchYoutube, searchYoutubeSchema, searchYoutubeOutputSchema } = await import("../dist/tools/search-youtube.js");
const { buildSearchFilters, resetForTesting } = await import("../dist/utils/youtube-api.js");
const { z } = await import("zod");
const output = z.object(searchYoutubeOutputSchema).strict();
const args = (a) => searchYoutubeSchema.parse({ query: "one minute film", ...a });

const SEARCH_RESPONSE = {
  contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
    {
      videoRenderer: {
        videoId: VIDEO_ID,
        title: { runs: [{ text: "First" }] },
        lengthText: { simpleText: "1:00" },
        ownerText: { runs: [{ text: "Chan" }] },
        publishedTimeText: { simpleText: "1 day ago" },
        shortViewCountText: { simpleText: "5 views" },
        thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/x.jpg", width: 1, height: 1 }] },
      },
    },
  ] } }] } } } },
  estimatedResults: "1",
};

let fake;
beforeEach(() => resetForTesting({ retrievePlayer: false }));
afterEach(() => fake?.restore());

function install() {
  fake = installFakeFetch([[/sw\.js_data|v1\/config/, status(500)], [/v1\/search/, json(SEARCH_RESPONSE)]]);
  return fake;
}

/** The encoded filter parameter youtubei.js sent in the last search request. */
function lastSearchParams() {
  const call = fake.calls.filter((c) => c.url.includes("/v1/search")).at(-1);
  return JSON.parse(call.body).params ?? null;
}

test("exactly supported options produce no warnings", () => {
  for (const sortBy of ["relevance", "viewCount"]) {
    for (const uploadDate of ["any", "today", "week", "month", "year"]) {
      for (const videoDuration of ["any", "short", "medium", "long"]) {
        assert.deepEqual(buildSearchFilters({ sortBy, uploadDate, videoDuration }).warnings, [], `${sortBy}/${uploadDate}/${videoDuration}`);
      }
    }
  }
  assert.deepEqual(buildSearchFilters({ sortBy: "viewCount", uploadDate: "week", videoDuration: "long" }).filters, {
    type: "video", upload_date: "week", duration: "over_twenty_mins", prioritize: "popularity",
  });
});

test("unsupported options are approximated or reported, never dropped silently", () => {
  const hour = buildSearchFilters({ sortBy: "relevance", uploadDate: "hour", videoDuration: "any" });
  assert.equal(hour.filters.upload_date, "today");
  assert.deepEqual(hour.warnings.map((w) => w.code), ["UPLOAD_DATE_APPROXIMATED"]);

  const rating = buildSearchFilters({ sortBy: "rating", uploadDate: "any", videoDuration: "any" });
  assert.equal(rating.filters.prioritize, "popularity");
  assert.deepEqual(rating.warnings.map((w) => w.code), ["SORT_APPROXIMATED"]);

  const date = buildSearchFilters({ sortBy: "date", uploadDate: "any", videoDuration: "any" });
  assert.equal(date.filters.prioritize, undefined);
  assert.deepEqual(date.warnings.map((w) => w.code), ["SORT_NOT_SUPPORTED"]);
});

test("search result carries warnings in structured content and text", async () => {
  install();
  const r = await callTool(searchYoutube, args({ sortBy: "date", uploadDate: "hour" }));
  assert.ok(!r.isError, JSON.stringify(r));
  const sc = output.parse(r.structuredContent);
  assert.equal(sc.resultCount, 1);
  assert.equal(sc.results[0].videoId, VIDEO_ID);
  assert.deepEqual(sc.warnings.map((w) => w.code), ["UPLOAD_DATE_APPROXIMATED", "SORT_NOT_SUPPORTED"]);
  assert.match(r.content[0].text, /⚠️ YouTube search cannot sort by upload date/);
});

test("warnings are omitted when every option was applied", async () => {
  install();
  const sc = output.parse((await callTool(searchYoutube, args({ sortBy: "viewCount", uploadDate: "week" }))).structuredContent);
  assert.equal("warnings" in sc, false);
});

test("'hour' sends the same filter to YouTube as 'today'", async () => {
  install();
  await callTool(searchYoutube, args({ uploadDate: "hour" }));
  const hourParams = lastSearchParams();
  await callTool(searchYoutube, args({ uploadDate: "today" }));
  const todayParams = lastSearchParams();
  await callTool(searchYoutube, args({ uploadDate: "any" }));
  const anyParams = lastSearchParams();
  assert.equal(hourParams, todayParams);
  assert.notEqual(hourParams, anyParams);
});

test("search results are cached per option set", async () => {
  install();
  await callTool(searchYoutube, args({ sortBy: "rating" }));
  await callTool(searchYoutube, args({ sortBy: "rating" }));
  assert.equal(fake.calls.filter((c) => c.url.includes("/v1/search")).length, 1);
});
