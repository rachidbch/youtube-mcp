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
    googleClient: null,
    googleRefreshTokenEnv: null,
  });
});

test("YT_DEFAULT_LANGS is parsed and validated", () => {
  assert.deepEqual(loadConfig({ YT_DEFAULT_LANGS: "en, pt-BR " }).defaultTranscriptLangs, ["en", "pt-br"]);
  for (const bad of ["", "   ", "1n", "english", "en_US"] ) {
    if (bad.trim() === "") continue; // empty falls back to the default
    assert.throws(() => loadConfig({ YT_DEFAULT_LANGS: bad }), /Invalid YT_DEFAULT_LANGS/, bad);
  }
});

test("account auth config: anonymous by default; client and token are separate", () => {
  assert.equal(loadConfig({}).googleClient, null);
  assert.equal(loadConfig({}).googleRefreshTokenEnv, null);

  const clientOnly = { YT_GOOGLE_CLIENT_ID: "cid", YT_GOOGLE_CLIENT_SECRET: "secret" };
  assert.deepEqual(loadConfig(clientOnly).googleClient, { clientId: "cid", clientSecret: "secret" });
  assert.equal(loadConfig(clientOnly).googleRefreshTokenEnv, null); // runtime auth via tools

  const full = { ...clientOnly, YT_GOOGLE_REFRESH_TOKEN: "rtok" };
  assert.equal(loadConfig(full).googleRefreshTokenEnv, "rtok");

  for (const [partial, msg] of [
    [{ YT_GOOGLE_CLIENT_ID: "cid" }, /CLIENT_ID is set but YT_GOOGLE_CLIENT_SECRET/],
    [{ YT_GOOGLE_CLIENT_SECRET: "secret" }, /CLIENT_SECRET is set but YT_GOOGLE_CLIENT_ID/],
    [{ YT_GOOGLE_REFRESH_TOKEN: "rtok" }, /REFRESH_TOKEN is set but the OAuth client/],
  ]) {
    assert.throws(() => loadConfig(partial), msg, JSON.stringify(partial));
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
