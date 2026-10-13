# youtube-mcp — project timeline (rachidbch fork)

## 2026-10-14 - Docs pass: AGENTS.md + ADR.md created, README fork section current

- AGENTS.md: project identity, ubiquitous language, agent loop, territory
  map, gates. ADR.md: ADR-001..005 (mission, merge+session-fix, robustness
  rule/youtubei.js, auth architecture, version policy). README fork section
  now lists all tools + both install shapes. Spec marked implemented.

## 2026-10-14 - Home feed + notifications on InnerTube (never-crash rule)

- No official API exists -> fragile surface accepted, wrapped robust:
  start_feed_auth (device-code login), get_my_feed, get_my_notifications;
  state in get_auth_status.feedAuth; reset_auth clears it too.
- Defensive parsing: shape surprises degrade to empty + note; auth gaps
  return actionable guidance; server never crashes. 15 tools anonymous.

## 2026-10-14 - Auth as an agent-driven state machine

- Replaced the env-all-or-nothing auth with a runtime state machine exposed
  as 4 always-registered tools: get_auth_status (authoritative: always
  re-verifies the refresh token), start_auth (consent URL + nonce, 15min
  TTL), complete_auth (accepts the pasted localhost redirect URL or bare
  code; exchanges server-side; stores token in YT_AUTH_STATE_FILE, mode 600,
  atomic), reset_auth (confirm-gated; revokes at Google best-effort).
- States: not_configured / not_authenticated / consent_pending /
  authenticated / expired, each with nextAction + agent-executable
  instructions. Covers first auth, expiry (revoked token), and rolls
  (complete_auth overwrites the stored token without restart).
- Install shapes verified by spawn: anonymous = 12 tools (8 public + 4 auth),
  client-configured = 14 (+2 account tools). Invalid env combos still
  fail fast at startup.
- 112 tests offline; lifecycle test walks the full machine including the
  cached-access-token-masks-revocation gap (status now forces a probe).

## 2026-10-14 - Authenticated mode: "my playlists" via Google OAuth (1.1.0)

- Install-time modes: anonymous (default, 8 tools) vs authenticated
  (YT_GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN all set -> +2 account tools;
  partial config refuses startup). Documented in README + .env.example.
- list_my_playlists: created playlists (any privacy, with counts + privacy
  status) + Liked + Uploads via official YouTube Data API v3 (youtube.readonly).
  get_my_playlist_videos: ordered items with position/addedAt; dead entries
  filtered. Watch Later: absent by design - Google's API never serves WL.
- Token manager: refresh-token -> access-token, cached ~1h, single-flight,
  one retry on stale-token 401; invalid_grant -> ACCESS_BLOCKED with re-login
  guidance. scripts/google-oauth-login.mjs: one-time consent helper
  (loopback flow, verifies the token before printing it).
- Verified: 108 tests offline (incl. mocked Google endpoints); anonymous
  spawn = 8 tools, auth'd spawn = 10, partial = refuses to start.
  Live E2E pending the owner's Google consent (deploy is pkg-gated).

## 2026-10-14 - Playlist affordances + download URL (1.1.0)

- 3 new tools: list_channel_playlists, get_playlist_videos,
  get_video_download_url; get_video_info gained `url`. Chain:
  channel -> playlists -> videos -> info/transcript/comments/download.
- New error codes: CHANNEL_UNAVAILABLE, PLAYLIST_UNAVAILABLE,
  DOWNLOAD_UNAVAILABLE. New utils: parse-channel-id, parse-playlist-id.
- youtubei 18 reality (probed live): channel playlists and playlist videos
  render as LockupView nodes read structurally; muxed direct download URLs
  only come from the ANDROID client (WEB/IOS are PO-token-gated, 403 on
  fetch); 'best' muxed is typically 360p (itag 18). Signed URLs ~6h.
- Verified locally E2E over raw MCP/HTTP (8 tools, pagination no-repeat,
  curl -I on download URL -> 200 video/mp4). Not deployed (owner-gated).

## 2026-10-14 - Merged upstream 1.0.1 + landed missing trust proxy fix

- Merged upstream/main (d3414b2): SDK 1.32.1, youtubei.js 18.1.0, error
  codes layer (errors.ts), abort/cancellation, TTL cache extraction,
  transcript pagination, test suite (91 tests), CI + release infra.
- 890dad3's message claimed `app.set("trust proxy", 1)` but never
  committed it; live journal showed ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
  500s through Tailscale Funnel. Landed in b408952.
- Session fix (onsessioninitialized) survived the merge; upstream still
  ships the broken post-connect `sessionId` check.

## 2026-07-05 - Streamable HTTP session registration bug fixed

**Problem:** mcpc clients (and PA's manage_mcp_server) could not connect.
`tools/list` and `tools/call` returned "Server not initialized" after a
successful `initialize`.

**Root cause:** `src/index.ts` ~line 142 checked `transport.sessionId`
immediately after `mcpServer.connect(transport)` and stored the transport
in the `transports` Map. But `sessionId` is set DURING `handleRequest()`,
not during `connect()`. So the check always failed — the transport was
never registered. The next request (the `initialized` notification) found
no existing transport and failed.

**Fix:** Replaced the broken pattern with the SDK's `onsessioninitialized`
callback (see SDK example at
`sseAndStreamableHttpCompatibleServer.js`). The transport is now stored
when the session initialization COMPLETES, not before.

**Also fixed:** `app.set("trust proxy", 1)` after `createMcpExpressApp`.
Without this, `express-rate-limit` throws `ValidationError` on
`X-Forwarded-For` headers (added by Tailscale Funnel).
