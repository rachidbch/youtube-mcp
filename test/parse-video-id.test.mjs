import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVideoId } from "../dist/utils/parse-video-id.js";

const ID = "C7OQHIpDlvA";

test("accepts raw IDs and supported YouTube URL forms", () => {
  for (const input of [
    ID,
    `  ${ID}  `,
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?v=${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc&t=10`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/v/${ID}`,
  ]) {
    assert.equal(parseVideoId(input), ID, input);
  }
});

test("rejects malformed and non-YouTube inputs", () => {
  for (const input of [
    "",
    "abc",
    `${ID}x`,                                   // 12 chars
    "C7OQHIpDlv!",                              // invalid char
    `https://www.youtube.com/watch?v=short`,
    `https://www.youtube.com/watch?v=${ID}x`,
    `https://www.youtube.com/watch`,
    `https://youtu.be/`,
    `https://youtu.be/${ID}/extra`,
    `https://evil.example.com/watch?v=${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://www.youtube.com/channel/UCabcdefghij`,
    `https://www.youtube.com/playlist?list=PL123`,
    `ftp://youtube.com/watch?v=${ID}`,
    `javascript:alert(1)//${ID}`,
  ]) {
    assert.throws(() => parseVideoId(input), /Could not extract video ID/, JSON.stringify(input));
  }
});
