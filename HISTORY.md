# youtube-mcp — project timeline (rachidbch fork)

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
