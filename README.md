# YouTube MCP

[![CI](https://github.com/granitebps/youtube-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/granitebps/youtube-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40granitebps%2Fyoutube-mcp.svg)](https://www.npmjs.com/package/@granitebps/youtube-mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40granitebps%2Fyoutube-mcp.svg)](https://www.npmjs.com/package/@granitebps/youtube-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-5A67D8.svg)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.granitebps%2Fyoutube-mcp)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

YouTube MCP lets an MCP client read YouTube video metadata, caption transcripts, comments, and search results. It needs no YouTube API key or account.

Supports both **stdio** (local) and **Streamable HTTP** (VPS/remote) transports.

## Features

| Tool | Description |
|------|-------------|
| `search_youtube` | Search videos with filters for upload date and popularity |
| `get_video_info` | Video metadata: title, channel, description, duration, views, likes, upload date, tags |
| `get_video_comments` | Comment threads with author info, likes, and the replies YouTube includes |
| `get_video_transcript` | Transcripts (manual + auto-generated captions) with timestamps |
| `get_transcript_languages` | Lists available manual and auto-generated caption languages |

## Requirements

- Node.js 22 or newer. CI checks Node 22.21.0 and Node 24.

> **No YouTube API key required.** This server uses `youtubei.js` (YouTube's InnerTube API) for video info, comments, and search, and `youtube-transcript-plus` for transcripts. Neither needs an API key or authentication.

## Quick start

Your MCP client can run the published package without a clone:

```bash
npx -y @granitebps/youtube-mcp
```

The server uses stdio. Keep stdout reserved for MCP traffic.

## Run from a cloned repository

To develop the server or use a clone directly:

```bash
git clone https://github.com/granitebps/youtube-mcp.git
cd youtube-mcp
npm ci
npm run build
```

Point your MCP client at the compiled entry point:

```text
node /absolute/path/to/youtube-mcp/dist/index.js
```

Run `npm run build` after each source change. Do not use `src` or `npm run dev` as the client's stdio command; build output on stdout can corrupt MCP messages.

## Client configuration

Each example starts with the npm package, followed by the local equivalent. Replace `/absolute/path/to/youtube-mcp` with your clone's path. Settings from [Configuration](#configuration) can be added as environment variables.

### Claude

Add the npm package to Claude Code:

```bash
claude mcp add youtube -- npx -y @granitebps/youtube-mcp
```

For a local build:

```bash
claude mcp add youtube -- node /absolute/path/to/youtube-mcp/dist/index.js
```

Claude Code uses local scope by default. Add `--scope user` before `youtube` to make the server available across projects.

Claude Desktop reads the same server from `claude_desktop_config.json` (on macOS, `~/Library/Application Support/Claude/claude_desktop_config.json`). Restart the app after editing the file.

```json
{
  "mcpServers": {
    "youtube": {
      "command": "npx",
      "args": ["-y", "@granitebps/youtube-mcp"]
    }
  }
}
```

For a local build, replace `command` and `args` with:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/youtube-mcp/dist/index.js"]
}
```

### Codex

Add the npm package to `~/.codex/config.toml`, or to `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.youtube]
command = "npx"
args = ["-y", "@granitebps/youtube-mcp"]
```

For a local build:

```toml
[mcp_servers.youtube]
command = "node"
args = ["/absolute/path/to/youtube-mcp/dist/index.js"]
```

Restart Codex after editing the file.

### OpenCode

Add the npm package to `opencode.json` or `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "youtube": {
      "type": "local",
      "command": ["npx", "-y", "@granitebps/youtube-mcp"],
      "enabled": true
    }
  }
}
```

For a local build, replace the `command` array with:

```json
{
  "command": ["node", "/absolute/path/to/youtube-mcp/dist/index.js"]
}
```

### Cursor

Add the npm package to `.cursor/mcp.json` in a project, or to `~/.cursor/mcp.json` for global use:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "npx",
      "args": ["-y", "@granitebps/youtube-mcp"]
    }
  }
}
```

For a local build, replace `command` and `args` with:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/youtube-mcp/dist/index.js"]
}
```

### GitHub Copilot (VS Code)

Add to your VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "youtube": {
        "command": "npx",
        "args": ["-y", "@granitebps/youtube-mcp"]
      }
    }
  }
}
```

---

## VPS deployment (Streamable HTTP)

For remote deployment, the server runs as a persistent HTTP service using the **Streamable HTTP** transport (the current MCP standard, replacing the deprecated SSE transport).

### 1. Deploy to your VPS

```bash
# On your VPS
git clone https://github.com/granitebps/youtube-mcp.git
cd youtube-mcp
npm ci
npm run build

# Create .env (optional, for HTTP mode)
cp .env.example .env
# Uncomment TRANSPORT=http, PORT, HOST as needed
```

### 2. Run with HTTP transport

```bash
# Using --http flag
node dist/index.js --http

# Or using environment variable
TRANSPORT=http PORT=3000 node dist/index.js

# Or using npm script
npm run start:http
```

The server will listen on `http://0.0.0.0:3000/mcp`.

### 3. Set up Nginx reverse proxy with TLS

```nginx
server {
    listen 443 ssl;
    server_name mcp.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.yourdomain.com/privkey.pem;

    location /mcp {
        proxy_pass http://127.0.0.1:3000/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for SSE streaming
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
    }
}
```

Get a free TLS certificate:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d mcp.yourdomain.com
```

### 4. Keep it running with systemd

Create `/etc/systemd/system/youtube-mcp.service`:

```ini
[Unit]
Description=YouTube MCP Server
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/youtube-mcp
ExecStart=/usr/bin/node dist/index.js --http
Restart=always
RestartSec=5
Environment=TRANSPORT=http
Environment=PORT=3000
Environment=HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable youtube-mcp
sudo systemctl start youtube-mcp
sudo systemctl status youtube-mcp
```

### 5. Connect MCP clients to your VPS

#### GitHub Copilot (VS Code) — Remote

```json
{
  "mcp": {
    "servers": {
      "youtube": {
        "type": "http",
        "url": "https://mcp.yourdomain.com/mcp"
      }
    }
  }
}
```

#### Claude Desktop — Remote

```json
{
  "mcpServers": {
    "youtube": {
      "type": "streamable-http",
      "url": "https://mcp.yourdomain.com/mcp"
    }
  }
}
```

---

## Usage Examples

Once connected, you can ask your AI agent things like:

- *"Get info about this YouTube video: https://www.youtube.com/watch?v=dQw4w9WgXcQ"*
- *"Show me the top comments on video ID abc123"*
- *"Get the transcript of this video in English"*
- *"Summarize the transcript of https://youtu.be/xyz789"*
- *"Search for Node.js tutorials uploaded this week, sorted by views"*
- *"Find the most popular React videos from the last month"*

## Tool Response Format

All tools return:

- `content`: short human-readable text for chat-style MCP clients
- `structuredContent`: JSON-shaped data for agents that need reliable fields

The server is intentionally **JSON-first, text-second**. Agents should prefer `structuredContent` when they need to filter, transform, or chain tool results.

Example shape from `get_video_info`:

```json
{
  "content": [
    {
      "type": "text",
      "text": "📹 Example title\n\nChannel: Example channel\n..."
    }
  ],
  "structuredContent": {
    "videoId": "dQw4w9WgXcQ",
    "title": "Example title",
    "description": "Example description",
    "channelName": "Example channel",
    "channelId": "UC123",
    "uploadedAt": "Sep 14, 2017",
    "duration": "3m 33s",
    "durationSeconds": 213,
    "viewCount": "123456",
    "likeCount": "7890",
    "commentCount": null,
    "tags": ["music", "pop"],
    "thumbnailUrl": "https://..."
  }
}
```

Values YouTube did not provide are `null`, never placeholders such as `"0"`, `"N/A"` or `"Unknown"`.

### Errors

Failures return `isError: true`. The text starts with a code (`❌ [ACCESS_BLOCKED] ...`) and `_meta["youtube-mcp/error"]` carries the details:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "❌ [ACCESS_BLOCKED] YouTube requires sign-in to access video C7OQHIpDlvA: Sign in to confirm you’re not a bot" }],
  "_meta": {
    "youtube-mcp/error": {
      "code": "ACCESS_BLOCKED",
      "message": "...",
      "retryable": false,
      "upstream": { "playabilityStatus": "LOGIN_REQUIRED", "reason": "Sign in to confirm you’re not a bot", "accessKind": "login_required" }
    }
  }
}
```

The error is in `_meta`, not `structuredContent`, because MCP SDK clients validate any `structuredContent` against the tool's output schema, even on error results.

| Code | Meaning |
|------|---------|
| `INVALID_INPUT` | Not a YouTube URL or 11-character video ID, or an invalid language code |
| `ACCESS_BLOCKED` | YouTube refused this client: HTTP 429/403, CAPTCHA, consent page, sign-in or bot check. `upstream.accessKind` is `rate_limited`, `forbidden`, `login_required` or `consent_required`. Says nothing about whether the video exists or has captions |
| `VIDEO_UNAVAILABLE` | YouTube reports the video as `ERROR`, `UNPLAYABLE`, private or offline. `upstream.reason` is YouTube's own text |
| `CAPTIONS_UNAVAILABLE` / `LANGUAGE_UNAVAILABLE` | Used internally; transcript tools return these as `available: false` results, not errors |
| `COMMENTS_UNAVAILABLE` | Comments are disabled or YouTube returned no comments section |
| `PARSE_ERROR` | YouTube answered but the response could not be interpreted (layout change, wrong video ID returned) |
| `LIMIT_EXCEEDED` | A configured size limit was hit |
| `TIMEOUT` | A configured deadline expired; the underlying requests were aborted |
| `CANCELLED` | The MCP client cancelled the request, or the server is shutting down |
| `UPSTREAM_ERROR` | Other HTTP or network failure (`retryable: true`) |

The server never retries on its own.

## Configuration

All settings are optional environment variables. Invalid values stop the server at startup with a message on stderr.

| Variable | Default | Effect |
|----------|---------|--------|
| `YT_INIT_TIMEOUT_MS` | `15000` | Deadline for creating the shared YouTube client |
| `YT_REQUEST_TIMEOUT_MS` | `20000` | Deadline for one tool call's upstream work, including waiting for client init |
| `YT_TRANSCRIPT_MAX_BYTES` | `5000000` | Maximum bytes read from each response fetched for captions |
| `YT_TRANSCRIPT_MAX_SEGMENTS` | `50000` | Maximum caption segments processed from one track |
| `YT_TRANSCRIPT_PAGE_MAX_SEGMENTS` | `500` | Maximum segments returned in one `get_video_transcript` response |

When a deadline expires or the client cancels, the in-flight HTTP requests are aborted, not just abandoned.

## Tool Details

### `search_youtube`
- **Input**: `query` (search text), `maxResults` (1-50, default 10), `sortBy` (`relevance` | `date` | `viewCount` | `rating`), `uploadDate` (`any` | `hour` | `today` | `week` | `month` | `year`), `videoDuration` (`any` | `short` | `medium` | `long`)
- **Returns**: Human-readable summary in `content` plus structured JSON results in `structuredContent`
- **Note**: YouTube search only orders by relevance or popularity and only filters uploads from `today` up. `sortBy: "date"` keeps relevance order, `sortBy: "rating"` sorts by popularity, and `uploadDate: "hour"` is applied as `today`. Each case adds an entry to the optional `warnings` array (`code`, `message`)

### `get_video_info`
- **Input**: `video` (YouTube URL or video ID)
- **Returns**: Human-readable summary in `content` plus structured JSON metadata in `structuredContent`, including `durationSeconds`. Metadata is returned even when YouTube refuses playback, as long as it provides the video details

### `get_video_comments`
- **Input**: `video` (URL or ID), `maxResults` (1-20, default 20), `sortBy` (`relevance` or `time`), `page` (default 1)
- **Returns**: Human-readable summary in `content` plus structured JSON comment threads, pagination fields, and `hasMore` in `structuredContent`
- **Note**: `replies` contains only replies YouTube includes with the thread; `replyCount` is the full count. Fetching the rest would cost one request per thread

### `get_video_transcript`
- **Input**: `video` (URL or ID), `lang` (optional language code; omitted means the first manual track, or the first auto-generated one if there is none), `maxSegments` (default `0`: as many as `YT_TRANSCRIPT_PAGE_MAX_SEGMENTS` allows), `startSegment` (default `0`)
- **Returns**: Human-readable transcript in `content` plus structured JSON segments, plain text, and pagination metadata in `structuredContent`. Continue with `startSegment = nextStartSegment` and the returned `languageCode` as `lang` while `hasMore` is true. `isAutoGenerated` tells whether the track is YouTube's automatic captions
- **No captions**: `available: false` with `reason: "NO_CAPTIONS"`, or `reason: "LANGUAGE_UNAVAILABLE"` plus `availableLanguages`. Access problems are errors, never `available: false`
- **Note**: When a language has both manual and automatic tracks, the manual track is returned
- **Note**: Does NOT require an API key — works via YouTube's internal caption system. A transcript is caption text only; it is not an analysis of the video's picture

### `get_transcript_languages`
- **Input**: `video` (YouTube URL or video ID)
- **Returns**: Human-readable language list in `content` plus structured JSON language metadata in `structuredContent`. `available: false` means the video is playable and has no caption tracks; access problems are errors

## Development

```bash
npm test        # builds, then runs the offline test suite (no network access)
npm run check   # tests plus release metadata, package contents, and tarball install checks
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Release verification

The automated suite covers input parsing, configuration, error classification, cancellation, the compiled stdio entry point, release metadata, and installation from an npm tarball. It never calls YouTube. Live YouTube checks are manual and separate from CI.

Maintainers follow the [release guide](RELEASE.md) for the approved-tag npm, MCP Registry, and GitHub release process.

## Rate Limits

This server uses YouTube's InnerTube API (the same API used by youtube.com). There are **no official API quotas**, but:
- Heavy automated usage may trigger CAPTCHAs or temporary blocks
- Use responsibly — add delays between bulk requests if needed
- All tools are free with no API key required

## License

[ISC](LICENSE). This project is unofficial and is not affiliated with YouTube or Google.
