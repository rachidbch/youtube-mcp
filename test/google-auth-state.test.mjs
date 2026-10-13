// Offline: Google auth state machine with a mocked fetch and a temp state file.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Client configured, no install-time token: the "first auth" install shape.
process.env.YT_GOOGLE_CLIENT_ID = "cid";
process.env.YT_GOOGLE_CLIENT_SECRET = "secret";
const stateDir = mkdtempSync(join(tmpdir(), "ytmcp-auth-"));
process.env.YT_AUTH_STATE_FILE = join(stateDir, "auth.json");

const mod = await import("../dist/utils/google-account.js");
const { resetAccountForTesting, getAuthStatus, startAuth, completeAuth, resetAuth, fetchMyPlaylists } = mod;
const { resetAuthTool } = await import("../dist/tools/reset-auth.js");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
let calls = [];

function installMock({ tokenOk = true, channelTitle = "Test Channel" } = {}) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    calls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (!tokenOk) return new Response('{"error": "invalid_grant"}', { status: 400 });
      const body2 = body.includes("grant_type=authorization_code")
        ? { access_token: "at", refresh_token: "NEW_REFRESH", expires_in: 3600 }
        : { access_token: "at", expires_in: 3600 };
      return json(body2);
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json({});
    if (url.includes("/youtube/v3/channels")) {
      if (url.includes("part=snippet")) {
        return json({ items: [{ id: "UC123", snippet: { title: channelTitle } }] });
      }
      return json({ items: [{ contentDetails: { relatedPlaylists: { likes: "LLxyz", uploads: "UUxyz" } } }] });
    }
    if (url.includes("/youtube/v3/playlists?")) return json({ items: [{ id: "PL1", snippet: { title: "Mix" }, status: { privacyStatus: "private" }, contentDetails: { itemCount: 2 } }] });
    throw new Error(`unexpected ${url}`);
  };
}

beforeEach(() => {
  resetAccountForTesting({ dropToken: true });
  installMock();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("lifecycle: not_authenticated -> consent_pending -> authenticated -> expired -> reset", async () => {
  // 1. First auth
  let status = await getAuthStatus();
  assert.equal(status.state, "not_authenticated");
  assert.equal(status.nextAction, "start_auth");

  const started = await startAuth();
  assert.equal(started.state, "consent_pending");
  assert.ok(started.consentUrl.includes("client_id=cid"));
  assert.ok(started.consentUrl.includes("localhost"));
  const nonce = new URL(started.consentUrl).searchParams.get("state");

  status = await getAuthStatus();
  assert.equal(status.state, "consent_pending");
  assert.equal(status.consentUrl, started.consentUrl);

  // 2. Complete with the redirect URL an agent would paste
  const redirect = `http://localhost:8479/?state=${encodeURIComponent(nonce)}&code=4%2F0AbCdEfGh123456789`;
  status = await completeAuth(redirect);
  assert.equal(status.state, "authenticated");
  assert.equal(status.tokenSource, "file");
  assert.deepEqual(status.account, { title: "Test Channel", channelId: "UC123" });

  const stored = JSON.parse(readFileSync(join(stateDir, "auth.json"), "utf8"));
  assert.equal(stored.refreshToken, "NEW_REFRESH");
  assert.equal((statSync(join(stateDir, "auth.json")).mode & 0o077), 0); // group/other: no access

  // 3. Account tools work with the stored token
  status = await getAuthStatus();
  assert.equal(status.state, "authenticated");
  const page = await fetchMyPlaylists(1);
  assert.equal(page.playlists[0].playlistId, "LLxyz");

  // 4. Expiry: Google starts rejecting the refresh token
  installMock({ tokenOk: false });
  status = await getAuthStatus();
  assert.equal(status.state, "expired");
  assert.equal(status.nextAction, "start_auth");
  assert.match(status.instructions, /start_auth/);

  // 5. Roll: re-auth overwrites the stored token
  installMock();
  const rolled = await startAuth();
  const rolledNonce = new URL(rolled.consentUrl).searchParams.get("state");
  status = await completeAuth(`http://localhost:8479/?state=${encodeURIComponent(rolledNonce)}&code=4%2F0SecondCode`);
  assert.equal(status.state, "authenticated");

  // 6. Reset revokes and clears
  status = await resetAuth(true);
  assert.equal(status.state, "not_authenticated");
  assert.ok(calls.some((u) => u.includes("/revoke")));
  status = await getAuthStatus();
  assert.equal(status.state, "not_authenticated");
});

test("complete_auth rejects a mismatched state parameter", async () => {
  await startAuth();
  await assert.rejects(
    () => completeAuth("http://localhost:8479/?state=someone-elses&code=4%2F0AbCdEf"),
    (e) => e.code === "INVALID_INPUT" && /state/.test(e.message),
  );
});

test("reset_auth tool refuses without confirm=true", async () => {
  const r = await resetAuthTool({ confirm: false, revoke: true });
  assert.equal(r.isError, true);
  assert.match(r._meta["youtube-mcp/error"].message, /confirm=true/);
});

test("account calls while unauthenticated give actionable guidance", async () => {
  await assert.rejects(() => fetchMyPlaylists(1), (e) => {
    assert.equal(e.code, "ACCESS_BLOCKED");
    assert.match(e.message, /get_auth_status/);
    return true;
  });
});

// Cleanup temp dir after the run
process.on("exit", () => rmSync(stateDir, { recursive: true, force: true }));
