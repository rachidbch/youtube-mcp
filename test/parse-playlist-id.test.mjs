import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaylistId } from "../dist/utils/parse-playlist-id.js";

const PL = "PLB5Ac5TbLc2OHUC5uaAuFdbxMXQK3ZaAF";

test("accepts raw playlist IDs", () => {
  assert.equal(parsePlaylistId(PL), PL);
  assert.equal(parsePlaylistId(`  ${PL}  `), PL);
  assert.equal(parsePlaylistId("WL"), "WL");
  assert.equal(parsePlaylistId("LL"), "LL");
});

test("extracts list= from watch and playlist URLs", () => {
  assert.equal(parsePlaylistId(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${PL}`), PL);
  assert.equal(parsePlaylistId(`https://www.youtube.com/playlist?list=${PL}`), PL);
  assert.equal(parsePlaylistId(`https://m.youtube.com/playlist?list=${PL}&si=x`), PL);
  assert.equal(parsePlaylistId(`https://music.youtube.com/watch?v=abc&t=0&list=${PL}`), PL);
});

test("rejects URLs without a valid list= and non-YouTube URLs", () => {
  for (const bad of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ", // no list
    "https://www.youtube.com/playlist",             // no list
    "https://www.youtube.com/playlist?list=short",  // list too short
    "https://example.com/playlist?list=" + PL,
    "short",
    "not a url at all!!",
  ]) {
    assert.throws(() => parsePlaylistId(bad), /Could not extract playlist/);
  }
});
