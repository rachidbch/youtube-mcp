# YouTube MCP v1.0.1

A patch release with two fixes. There are no tool, input, or error-code changes
from 1.0.0; `search_youtube` gains an optional `warnings` result field.

## Install

Run the exact version with Node.js 22 or newer:

```bash
npx -y @granitebps/youtube-mcp@1.0.1
```

See the
[client configuration guide](https://github.com/granitebps/youtube-mcp/blob/v1.0.1/README.md#client-configuration)
for Claude, Codex, OpenCode, Cursor, and VS Code examples.

## Changes

- `search_youtube` reports options YouTube search cannot apply instead of
  ignoring them silently. YouTube only orders search results by relevance or
  popularity and only filters uploads from "today" up:
  - `sortBy: "date"` keeps relevance order (`SORT_NOT_SUPPORTED`);
  - `sortBy: "rating"` sorts by popularity (`SORT_APPROXIMATED`);
  - `uploadDate: "hour"` is applied as `today` (`UPLOAD_DATE_APPROXIMATED`).

  Each case adds an entry to the optional `warnings` array and a line in the
  text summary. Before this release, `date` and `hour` had no effect.
- The video-info, comments, and search caches have a size limit and drop
  expired entries, so a long-running server no longer grows without bound.
- This is the first version published by the release workflow through npm
  trusted publishing, so npm shows a provenance attestation.

## Compatibility

The
[v1 compatibility contract](https://github.com/granitebps/youtube-mcp/blob/v1.0.1/docs/v1-compatibility.md)
is unchanged apart from the new optional search field, which the contract
allows within 1.x.

## Known limitations

- YouTube may rate-limit, CAPTCHA, or require sign-in for some networks,
  especially cloud and VPS IP ranges. Those cases return `ACCESS_BLOCKED`; the
  server does not use cookies, proxies, or accounts.
- When a language has both manual and auto-generated captions, only the manual
  track can be fetched.
- Comment replies include only those YouTube sends with the thread, and
  `commentCount` is often `null`.
- A transcript is caption text only; the server does not analyze video frames.

This project is unofficial and is not affiliated with YouTube or Google. Report
suspected vulnerabilities through the
[private security route](https://github.com/granitebps/youtube-mcp/security/advisories/new),
not a public issue.
