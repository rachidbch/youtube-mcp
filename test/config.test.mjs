import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/utils/config.js";

test("defaults apply when env is empty", () => {
  const c = loadConfig({});
  assert.deepEqual(c, {
    initTimeoutMs: 15000,
    requestTimeoutMs: 20000,
    transcriptMaxBytes: 5000000,
    transcriptMaxSegments: 50000,
    transcriptPageMaxSegments: 500,
    defaultTranscriptLangs: ["en"],
    accountAuth: null,
  });
});

test("YT_DEFAULT_LANGS is parsed and validated", () => {
  assert.deepEqual(loadConfig({ YT_DEFAULT_LANGS: "en, pt-BR " }).defaultTranscriptLangs, ["en", "pt-br"]);
  for (const bad of ["", "   ", "1n", "english", "en_US"] ) {
    if (bad.trim() === "") continue; // empty falls back to the default
    assert.throws(() => loadConfig({ YT_DEFAULT_LANGS: bad }), /Invalid YT_DEFAULT_LANGS/, bad);
  }
});

test("account auth: anonymous by default, all-or-nothing env", () => {
  assert.equal(loadConfig({}).accountAuth, null);
  const full = {
    YT_GOOGLE_CLIENT_ID: "cid",
    YT_GOOGLE_CLIENT_SECRET: "secret",
    YT_GOOGLE_REFRESH_TOKEN: "rtok",
  };
  assert.deepEqual(loadConfig(full).accountAuth, { clientId: "cid", clientSecret: "secret", refreshToken: "rtok" });
  for (const partial of [
    { YT_GOOGLE_CLIENT_ID: "cid" },
    { YT_GOOGLE_CLIENT_ID: "cid", YT_GOOGLE_CLIENT_SECRET: "secret" },
  ]) {
    assert.throws(() => loadConfig(partial), /Invalid account auth configuration/, JSON.stringify(partial));
  }
});

test("env overrides are parsed", () => {
  const c = loadConfig({
    YT_INIT_TIMEOUT_MS: "1000",
    YT_REQUEST_TIMEOUT_MS: "2000",
    YT_TRANSCRIPT_MAX_BYTES: "300",
    YT_TRANSCRIPT_MAX_SEGMENTS: "40",
    YT_TRANSCRIPT_PAGE_MAX_SEGMENTS: "5",
  });
  assert.equal(c.initTimeoutMs, 1000);
  assert.equal(c.requestTimeoutMs, 2000);
  assert.equal(c.transcriptMaxBytes, 300);
  assert.equal(c.transcriptMaxSegments, 40);
  assert.equal(c.transcriptPageMaxSegments, 5);
});

test("invalid values fail fast", () => {
  for (const bad of ["0", "-5", "1.5", "abc", "10ms", "99999999999999999999"]) {
    assert.throws(() => loadConfig({ YT_REQUEST_TIMEOUT_MS: bad }), /Invalid YT_REQUEST_TIMEOUT_MS/, bad);
  }
});
