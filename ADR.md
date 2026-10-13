# ADR — youtube-mcp fork

## ADR-001: Fork mission — playlist chain + download URL + account data

Status: accepted (2026-10-14)

Context: upstream exposes 5 video-scoped tools; the owner wants an agent to
walk channel -> playlists -> videos -> per-video details and downloads, plus
the owner's own playlists.

Decision: add list_channel_playlists, get_playlist_videos,
get_video_download_url, get_video_info.url on the anonymous surface; account
surfaces added later (ADR-004).

Consequences: 8 anonymous data tools; LockupView read structurally with
nullable fields; download URLs restricted to muxed (360p typical) because
YouTube gates adaptive URLs behind PO tokens.

## ADR-002: Merge upstream 1.0.1; keep session fix; land trust proxy

Status: accepted (2026-10-14)

Context: upstream shipped error taxonomy, abort infra, tests, CI. Local fix
890dad3 (onsessioninitialized) fixed a registration race; its message claimed
a trust-proxy fix that was never committed (live ERR_ERL 500s through
Tailscale Funnel).

Decision: merge upstream (clean); our session hunk survives because upstream
never touched it — upstream still ships the broken pattern, so every future
merge must re-verify it. Land app.set("trust proxy", 1) as b408952.

Consequences: SDK 1.32.1, youtubei.js 18.1.0, 91 inherited tests; deploy must
run npm install to pick dependency updates (pending pkg review).

## ADR-003: Stay on youtubei.js; unpin; never-crash rule; yt-dlp deferred

Status: accepted (2026-10-14)

Context: LockupView reads and ANDROID-client download URLs are fragile. yt-dlp
is the most robust extractor (community-maintained client rotation, PO-token
plugin ecosystem); youtubei.js tracks the same research (same author as
BgUtils) but was exact-pinned so fixes never reached us.

Decision: robust-first — official surfaces where they exist; fragile surfaces
allowed only when no robust option exists, wrapped in defensive parsing that
degrades to nulls/empty + notes, never crashes. Unpin youtubei.js to ^18.1.0.
yt-dlp subprocess for download URLs deferred until the current ANDROID path
actually breaks (flip to it then).

Consequences: android_vr/web/ios URLs verified unusable (403/absent) —
ANDROID muxed is the only working direct-link path today.

## ADR-004: Auth architecture — official API + agent-driven state machine

Status: accepted (2026-10-14)

Context: owner wants their playlists (private included), liked list;
optionally home feed and notifications. Google's Data API covers playlists
but has NO home feed (deprecated) and NO notifications.

Decision: two separate one-time consents, both agent-drivable:
1. Account auth: Data API v3, scope youtube.readonly, refresh token in a
   0600 state file (YT_AUTH_STATE_FILE); get_auth_status/start_auth/
   complete_auth/reset_auth state machine (not_configured ->
   not_authenticated -> consent_pending -> authenticated / expired).
2. feedAuth: InnerTube device-code login (start_feed_auth) for
   get_my_feed/get_my_notifications — ADR-003's fragile-by-necessity case.

Watch Later is unobtainable: Google's API never serves WL; documented, not
worked around. Install-time env decides install shape (anonymous vs
client-configured); invalid combos fail fast at startup.

Consequences: anonymous = 15 tools, client-configured = 17; tokens never in
the repo; reset_auth clears both sessions.

## ADR-005: Version policy — sync package.json + lockfile + server.json

Status: accepted (2026-10-14)

Context: fork leaned toward bumping package.json only; upstream's
release-contract test enforces version equality across package.json,
package-lock.json, and server.json.

Decision: bump all (server.json both fields) via npm version + npm install.
CHANGELOG.md stays untouched (upstream's; only required per release tag).

Consequences: small merge friction in three files; CI stays green.
