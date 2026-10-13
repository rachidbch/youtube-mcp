import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChannelRef } from "../dist/utils/parse-channel-id.js";

const UC = "UC8butISFwT-Wl7EV0hUK0BQ";

test("accepts raw UC channel IDs", () => {
  assert.deepEqual(parseChannelRef(UC), { kind: "id", channel: UC });
  assert.deepEqual(parseChannelRef(`  ${UC}  `), { kind: "id", channel: UC });
});

test("extracts /channel/UC... URLs without needing resolution", () => {
  for (const url of [
    `https://www.youtube.com/channel/${UC}`,
    `https://youtube.com/channel/${UC}/featured`,
    `http://m.youtube.com/channel/${UC}?si=abc`,
  ]) {
    assert.deepEqual(parseChannelRef(url), { kind: "id", channel: UC });
  }
});

test("maps @handle, /c/ and /user/ URLs to resolvable URLs", () => {
  assert.deepEqual(parseChannelRef("https://www.youtube.com/@freecodecamp"), {
    kind: "url",
    url: "https://www.youtube.com/@freecodecamp",
  });
  assert.deepEqual(parseChannelRef("https://youtube.com/c/SomeName/videos"), {
    kind: "url",
    url: "https://www.youtube.com/c/SomeName",
  });
  assert.deepEqual(parseChannelRef("https://www.youtube.com/user/SomeUser"), {
    kind: "url",
    url: "https://www.youtube.com/user/SomeUser",
  });
});

test("maps a bare @handle to a resolvable URL", () => {
  assert.deepEqual(parseChannelRef("@freecodecamp"), {
    kind: "url",
    url: "https://www.youtube.com/@freecodecamp",
  });
});

test("rejects non-YouTube URLs, bare names, and garbage", () => {
  for (const bad of [
    "",
    "   ",
    "freecodecamp",           // bare name without @ is ambiguous -> rejected
    "https://example.com/@x",
    "https://youtube.com/",   // bare homepage, no channel path
    "UC123",                  // too short
    "not a url at all!!",
  ]) {
    assert.throws(() => parseChannelRef(bad), /Could not parse channel/);
  }
});
