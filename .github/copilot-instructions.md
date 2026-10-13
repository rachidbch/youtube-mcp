# Copilot Instructions

## Build, test, and lint commands

- `npm install` installs dependencies.
- `npm run build` compiles the TypeScript source in `src/` to `dist/`. This is the main verification command currently configured in the repo.
- `npm start` runs the built MCP server over stdio from `dist/index.js`.
- `npm run start:http` runs the built server in Streamable HTTP mode. `node dist/index.js --http` is equivalent.
- `npm run dev` and `npm run dev:http` do a one-time `tsc` build and then start the server; they are not watch-mode commands.
- `npm run check` runs `npm test` plus the release checks: `check:release` (package, lockfile, and `server.json` versions agree; workflow policy), `check:package` (packed file allow-list), and `check:install` (installs the packed tarball and lists tools over stdio). CI runs it on Node 22.21.0 and 24.
- Releases follow `RELEASE.md`: a pushed `v*` tag publishes npm, then the MCP Registry, then a GitHub release. Never create or push a release tag without explicit approval of the version and commit. Keep the version in `package.json`, `package-lock.json`, and `server.json` in sync, and add `docs/release-notes-vX.Y.Z.md` plus a `CHANGELOG.md` entry.
- `npm test` builds and runs the offline suite in `test/*.test.mjs` with Node's built-in test runner against `dist/`. Tests replace `globalThis.fetch` with fakes from `test/helpers.mjs`; they never touch the network. Run one file with `npm run build && node --test test/transcript.test.mjs`.
- There is no `lint` script.

## High-level architecture

- `src/index.ts` is the only entrypoint. It builds an `McpServer`, registers all tools, and then selects the transport:
  - stdio by default via `StdioServerTransport`
  - HTTP when `--http` is passed or `TRANSPORT=http` is set
- In HTTP mode, `src/index.ts` builds an Express app through the MCP SDK, adds optional bearer-token auth with `API_TOKEN`, rate-limits `/mcp`, and keeps a `Map<string, StreamableHTTPServerTransport>` so each MCP session can continue across requests.
- Each tool lives in `src/tools/` and follows the same pattern:
  - export a Zod schema
  - export an output schema for `structuredContent`
  - export an async handler
  - register the tool in `createServer()` using `inputSchema: schema.shape` and `outputSchema`
  - wrap the handler with `withLogging(...)`
- Shared YouTube access lives in `src/utils/youtube-api.ts`. That module owns:
  - the singleton `youtubei.js` `Innertube` client
  - TTL caches for video info, comment pages, and search results
  - per-call deadlines via `runWithDeadline` (`src/utils/abort.ts`), linked to the MCP request's `extra.signal`
- `src/utils/abort.ts` keeps the current call's `AbortSignal` in `AsyncLocalStorage`. `contextFetch` is passed to youtubei.js as its `fetch`, and the transcript library's `videoFetch`/`playerFetch`/`transcriptFetch` hooks also use it, so cancellation aborts real HTTP requests. It turns HTTP 403/429 into `ACCESS_BLOCKED` before a library can relabel them.
- `src/utils/config.ts` reads the `YT_*` limits once at startup.
- Transcript features are the notable exception to the `youtubei.js` path:
  - `get_video_transcript` and `get_transcript_languages` use `youtube-transcript-plus`
  - metadata, comments, and search use `youtubei.js`
- `src/utils/parse-video-id.ts` is the normalization layer for every tool that accepts a URL or ID. It supports watch URLs, `youtu.be`, embed URLs, shorts, live URLs, and raw 11-character IDs.

## Key conventions

- Tool responses are JSON-first for agents and text-second for humans. Successful handlers should return both `structuredContent` and concise `content` text; `outputSchema` in `src/index.ts` should stay aligned with the `structuredContent` shape.
- Use `content` for short summaries, not as the only source of truth. Agents should be able to consume stable fields from `structuredContent` without parsing prose, emojis, or pagination hints out of text.
- Operational failures return `errorResult(err)` from `src/utils/errors.ts`: `isError: true`, text prefixed with `[CODE]`, and the error object in `_meta["youtube-mcp/error"]`. Do not put error objects in `structuredContent`; MCP SDK clients validate it against the output schema even on errors.
- Throw `YouTubeError` with the most specific code and keep upstream evidence (HTTP status, playability status, YouTube's reason). Never report an access failure (`ACCESS_BLOCKED`) as a missing video or missing captions.
- Unknown metadata values are `null`, not placeholder strings.
- Keep logs on stderr only. `src/utils/logger.ts` writes directly to `process.stderr`, which is important so stdio MCP responses stay clean on stdout.
- Reuse the existing normalization and transport patterns when adding tools:
  - parse user input with `parseVideoId(...)`
  - keep request-specific error handling in the tool module
  - keep shared YouTube client/caching logic in `src/utils/youtube-api.ts`
- Schema descriptions matter here. The Zod field descriptions in each tool schema are used as MCP-facing input documentation, so keep them specific and client-friendly when changing or adding parameters.
- The repo assumes no YouTube API key. README and `.env.example` both reflect that all data comes from `youtubei.js` or `youtube-transcript-plus`; the environment variables in scope are transport/network settings, optional `API_TOKEN` protection for HTTP mode, and the `YT_*` operational limits.
- Keep youtubei.js's default `retrieve_player`. Without the player script, YouTube reports available videos as `UNPLAYABLE` and omits caption tracks.
