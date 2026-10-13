# YouTube MCP v1.0.0

First published release. YouTube MCP reads YouTube video metadata, caption
transcripts, comments, and search results through MCP, without a YouTube API
key or account.

## Install

Run the exact version with Node.js 22 or newer:

```bash
npx -y @granitebps/youtube-mcp@1.0.0
```

See the
[client configuration guide](https://github.com/granitebps/youtube-mcp/blob/v1.0.0/README.md#client-configuration)
for Claude, Codex, OpenCode, Cursor, and VS Code examples.

## Highlights

- Five tools: `get_video_info`, `get_transcript_languages`,
  `get_video_transcript`, `get_video_comments`, and `search_youtube`.
- Errors carry a stable code and YouTube's own evidence (HTTP status,
  playability status, reason). Rate limits, bot checks, and sign-in walls are
  reported as `ACCESS_BLOCKED`, never as a deleted video or missing captions.
- Deadlines and MCP cancellation abort the underlying HTTP requests.
- Transcripts paginate with `startSegment` / `nextStartSegment`, report whether
  the track is auto-generated, and default to the first manual track when no
  language is given.
- Timeouts and transcript size limits are configurable through `YT_*`
  environment variables.

## Compatibility

The
[v1 compatibility contract](https://github.com/granitebps/youtube-mcp/blob/v1.0.0/docs/v1-compatibility.md)
covers tool names, inputs, result fields, and error codes throughout 1.x.

## Known limitations

- YouTube may rate-limit, CAPTCHA, or require sign-in for some networks,
  especially cloud and VPS IP ranges. Those cases return `ACCESS_BLOCKED`; the
  server does not use cookies, proxies, or accounts.
- When a language has both manual and auto-generated captions, only the manual
  track can be fetched.
- Comment replies include only those YouTube sends with the thread.
- A transcript is caption text only; the server does not analyze video frames.
- This npm version was published manually and has no provenance attestation.

This project is unofficial and is not affiliated with YouTube or Google. Report
suspected vulnerabilities through the
[private security route](https://github.com/granitebps/youtube-mcp/security/advisories/new),
not a public issue.
