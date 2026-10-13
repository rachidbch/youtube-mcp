# youtube-mcp (rachidbch fork) — agent harness

Fork of granitebps/youtube-mcp, pushed to github.com/rachidbch/youtube-mcp.
A YouTube MCP server: metadata, transcripts, comments, search, playlists,
download URLs, and account-scoped data (playlists, home feed, notifications).

## Objectives

- Give agent consumers a coherent chain: channel -> playlists -> videos ->
  info/transcript/comments/download URL.
- Account data through the most robust surface available: Google's official
  Data API when one exists; InnerTube only where nothing official does.
- Never crash on YouTube's shape changes: degrade to nulls/empty + notes.

## Ubiquitous language

- InnerTube: YouTube's private API; the surface youtubei.js speaks.
- PO token: Google's proof-of-origin attestation; missing tokens gate
  streaming URLs (why download links use the ANDROID client identity).
- LockupView: modern InnerTube page-rendering block; read structurally,
  never assume fields (duration lives in thumbnail badges, may be absent).
- Auth state machine: get_auth_status states; account auth (Data API,
  youtube.readonly) is SEPARATE from feedAuth (InnerTube device-code).
- Install shapes: anonymous (no YT_GOOGLE_* env) vs client-configured
  (YT_GOOGLE_CLIENT_ID/SECRET set; token optional, runtime-rolled).

## Agent loop

1. Change code in src/, keep house conventions: one file per tool in
   src/tools/, fetchers in src/utils/, errors via YouTubeError taxonomy,
   runWithDeadline + extra.signal on every network path.
2. `npm run build` then `npm test` (offline, ~112 tests) - both must be green.
3. Live-verify new behavior locally: spawn `node dist/index.js` (stdio or
   --http) and speak MCP; never deploy to test.
4. Update HISTORY.md (event lines) and ADR.md when a decision concludes.
5. Commit plain messages, no agent co-author; push origin main; CI+Release
   workflows must go green (gh run list).

## Territory map

- src/index.ts: tool registration; install shape decides tool count
  (anonymous 15, client-configured 17). Do not break the count tests
  (test/stdio.test.mjs, scripts/check-install.mjs expected lists).
- src/utils/youtube-api.ts: anonymous fetchers + caches. google-account.ts:
  Data API + auth state machine. youtube-feed.ts: InnerTube session,
  feed/notifications (defensive parsing by mandate).
- scripts/check-*.mjs: upstream's release verification; fork edits allowed
  (expected tool list already diverges).
- Upstream merge: upstream/main still ships the broken post-connect
  sessionId check; our onsessioninitialized fix must survive every merge
  (see HISTORY 2026-07-05). Check upstream changes to src/index.ts twice.
- Deployment: Incus container `youtube-mcp` on cloudai, /opt/youtube-mcp
  is NOT a git clone; deploy is owner-gated (cloudify pkg review pending).
  Prod still lacks the trust-proxy fix until then (Funnel 500s).
- scratchpad/: throwaway specs; not shipped.

## Gates

- HISTORY.md: timeline, one-liners per event.
- ADR.md: concluded decisions only; never edit past ADRs.
- CHANGELOG.md is upstream's release artifact: never edit.
