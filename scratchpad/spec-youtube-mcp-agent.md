# Task: add playlist affordances + download URL to youtube-mcp

> STATUS 2026-10-14: implemented (commit 654cfdd) and since extended — auth
> state machine + account/feed tools supersede parts of this spec. Authoritative
> docs now: README "Fork" section, AGENTS.md, ADR.md. Kept for history.

You own the codebase at ~/PROJECTS/GIT/youtube-mcp (fork of granitebps/youtube-mcp,
pushed as github.com/rachidbch/youtube-mcp). Implement, don't re-litigate; gaps or
surprises: report back instead of improvising.

## Context (post 1.0.1 merge — conventions below reflect the merged code)

- The server runs as a systemd unit inside the Incus container `youtube-mcp` ON
  cloudai, serving `https://youtube-mcp.komodo-everest.ts.net/mcp` (bearer auth).
  DEPLOYMENT IS OWNER-GATED: do not deploy, do not touch the container.
- youtubei.js is pinned 18.1.0 in the repo — the LOCAL install under
  node_modules is the reference for API shapes
  (node_modules/youtubei.js/dist/src/Innertube.d.ts etc).
- Current tools (5, all video-scoped): get_video_info, get_video_comments,
  get_video_transcript, search_youtube, get_transcript_languages.
- Upstream conventions that now apply: typed errors via `YouTubeError` +
  `errorResult()` (`❌ [CODE] msg`, machine-readable `_meta["youtube-mcp/error"]`),
  request deadlines via `runWithDeadline` + `config.requestTimeoutMs`,
  cancellation via handlers' `extra.signal`, unit tests under test/ (node --test).
- Library surface verified present in 18.1.0:
  - `getChannel(id)` -> Channel (TabbedFeed) with `has_playlists` + Playlists tab
  - `resolveURL(url)` -> NavigationEndpoint (handles @handle, /c/, /user/ forms)
  - `getPlaylist(id)` -> `.items` (PlaylistVideo | LockupView | ReelItem |
    ShortsLockupView), `.info.total_items`, `getContinuation()` (~100 items/page)
  - `getStreamingData(video_id, options: FormatOptions)` -> deciphered Format
    with the DIRECT download URL (signed, ~6h expiry)

## Goal: a coherent playlist -> video -> details chain

An agent user must be able to: list a channel's playlists, list a playlist's
videos, then per video get url, description, comments, transcript, and a direct
download URL. Built-in playlists (Liked `LL`, Watch-later `WL`) are account-scoped
and unreachable anonymously - they simply won't appear; that is expected, no
special handling.

## Task 1: list_channel_playlists (new tool)

- Input: `channel` (URL, @handle, /c/ path, or UC... ID) + `page` (default 1).
  Add a `parseChannelId` util mirroring parse-video-id.ts; resolve non-UC forms
  via the library's `resolveURL` (construct
  `https://www.youtube.com/@handle` from a bare @handle), never hand-rolled
  scraping.
- Walk the Playlists tab with continuations per page (~30/page server-side).
- Output per item: `{playlistId, title, videoCount, url}` where
  `url = https://www.youtube.com/playlist?list=<id>`.
- Pagination shape: `{page, hasMore, totalFetched}` - same convention as the
  comments tool.
- New error code `CHANNEL_UNAVAILABLE` for unresolvable channels.

## Task 2: get_playlist_videos (new tool)

- Input: `playlist` (URL or playlist ID) + `page` (default 1) + `maxResults`
  (default 25, cap 100). Parse `list=` param like parse-video-id does for `v=`.
- One `getPlaylist` call + N `getContinuation()` walks to reach the page.
- Output: playlist metadata `{playlistId, title, totalVideos}` + per video
  `{videoId, title, url, duration, channelName}` (url =
  `https://www.youtube.com/watch?v=<id>`; reuse formatDuration).
- Filter non-video items (ReelItem/Shorts/LockupView that are not PlaylistVideo)
  out of items - count and return videos only.
- Same pagination shape as Task 1. New error code `PLAYLIST_UNAVAILABLE`.

## Task 3: get_video_download_url (new tool)

- Input: `video` (URL or ID, reuse parse-video-id) + optional `quality`
  (default best) and `format` (default mp4) - FormatOptions accepts quality
  'best'/'bestefficiency'/'<height>p', format 'mp4'/'webm'/'any'; type stays
  'video+audio' (muxed single file).
- Use `getStreamingData` (NOT `download()` - no streaming in v1).
- Output: `{videoId, title, url, mimeType, fileSize, qualityLabel, expiresNote}`
  with a text note that the URL is signed and expires in ~6 hours.
- Description must be honest about muxed reality: "best single-file mp4 is
  typically 360p/720p; separate audio+video merge is not done server-side".
- Explicitly OUT of scope v1: saving/streaming files server-side, progress
  reporting, format merging. Consumers curl the URL themselves.

## Task 4: small edit - get_video_info gains `url`

Add `url` (`https://www.youtube.com/watch?v=<id>`) to VideoInfo interface,
fetcher result, output schema, and the text rendering. No other behavior change.

## House rules (follow the MERGED code conventions)

- One file per tool in src/tools/: zod input schema + exported outputSchema
  object (plain object of zod props, like getVideoInfoOutputSchema) + exported
  async handler `(args, extra?: { signal?: AbortSignal })` returning
  `{content:[{type:"text"}], structuredContent}`.
- Fetchers live in src/utils/youtube-api.ts alongside the existing ones:
  typed interfaces, `runWithDeadline` + `config.requestTimeoutMs`, `TTLCache`
  entries (channel playlists 30min, playlist videos 15min, download URLs ~10min
  so we never serve near-expiry links), errors via `YouTubeError` taxonomy.
- Tool errors: `errorResult(new YouTubeError(...))` - exactly like the others.
- registerTool in src/index.ts with a description written for an LLM caller
  (state input forms, pagination, what it returns; mention Task 1 -> Task 2 ->
  Task 3 chaining in the descriptions).
- Do not break the 5 existing tools; no dependency additions; youtubei.js stays
  the only YouTube surface.
- Unit tests for new pure logic (parse-channel-id, parse-playlist-id) under
  test/, same style as test/parse-video-id.test.mjs. `npm test` must pass.
- Version bump package.json to 1.1.0 AND server.json (both version fields): the
  upstream release-contract test enforces sync between package.json,
  package-lock.json, and server.json. Run `npm install` to sync the lockfile
  version fields. CHANGELOG.md stays untouched (only required for tags).
- Commit messages: plain, no agent co-author line. Push to origin main at the
  end.

## Verification (E2E, required - this is the acceptance gate)

No deployment (owner-gated). Verify locally against a real server instance:

1. `npm run build` clean, `npm test` all green (existing 91 + new).
2. Start the server locally in HTTP mode (localhost, throwaway API_TOKEN) and
   speak raw MCP over it (initialize, initialized, tools/list): expect 8 tools.
3. Live tool calls through that endpoint:
   - list_channel_playlists on a real channel with several playlists
     (e.g. freeCodeCamp), confirm >=1 page and sane fields
   - get_playlist_videos page 1 + page 2 on a playlist with >100 videos,
     confirm hasMore flips and videoIds don't repeat across pages
   - get_video_download_url best/mp4 on a video, curl -I the returned URL,
     confirm 200 + content-type/video length headers
   - get_video_info returns the new url field
   - one regression: get_video_transcript still works
4. Mind the local endpoint rate limit (60 req/min) - pace the probes.

## Report back

- Files added/changed, version, commit range pushed.
- The E2E transcript (tool calls + key fields, trimmed).
- Any deviation from this spec with reason; anything in the library that
  behaved differently than the spec assumed.
- If a pagination or parsing edge case is genuinely unreachable (e.g. handle
  resolution failing for a channel form), say so explicitly rather than
  papering over it.
