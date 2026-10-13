#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import {
  getVideoInfo,
  getVideoInfoOutputSchema,
  getVideoInfoSchema,
} from "./tools/get-video-info.js";
import {
  getVideoComments,
  getVideoCommentsOutputSchema,
  getVideoCommentsSchema,
} from "./tools/get-video-comments.js";
import {
  getVideoTranscript,
  getVideoTranscriptOutputSchema,
  getVideoTranscriptSchema,
} from "./tools/get-video-transcript.js";
import {
  searchYoutube,
  searchYoutubeOutputSchema,
  searchYoutubeSchema,
} from "./tools/search-youtube.js";
import {
  getTranscriptLanguages,
  getTranscriptLanguagesOutputSchema,
  getTranscriptLanguagesSchema,
} from "./tools/get-transcript-languages.js";
import {
  getVideoDownloadUrl,
  getVideoDownloadUrlOutputSchema,
  getVideoDownloadUrlSchema,
} from "./tools/get-video-download-url.js";
import {
  getPlaylistVideos,
  getPlaylistVideosOutputSchema,
  getPlaylistVideosSchema,
} from "./tools/get-playlist-videos.js";
import {
  listChannelPlaylists,
  listChannelPlaylistsOutputSchema,
  listChannelPlaylistsSchema,
} from "./tools/list-channel-playlists.js";
import { closeClient } from "./utils/youtube-api.js";
import { abortAll } from "./utils/abort.js";
import { logger, withLogging } from "./utils/logger.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/** Version reported to MCP clients; package.json is one level above dist/. */
const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

function createServer(): McpServer {
  const server = new McpServer({
    name: "youtube-mcp",
    version: packageVersion,
  });

  server.registerTool("get_video_info", {
    description:
      "Get YouTube video metadata: title, channel, description, duration (text and seconds), views, likes, comment count, upload date, and tags. Unknown values are null. Input: YouTube URL or video ID. Errors carry a code (e.g. ACCESS_BLOCKED, VIDEO_UNAVAILABLE, TIMEOUT) in _meta[\"youtube-mcp/error\"] and as a [CODE] text prefix.",
    inputSchema: getVideoInfoSchema.shape,
    outputSchema: getVideoInfoOutputSchema,
  }, withLogging("get_video_info", getVideoInfo));

  server.registerTool("get_video_comments", {
    description:
      "Get YouTube video comments with replies. Returns comment text, author, likes, and date. Supports sorting by 'relevance' (top comments) or 'time' (newest). Returns error if comments are disabled.",
    inputSchema: getVideoCommentsSchema.shape,
    outputSchema: getVideoCommentsOutputSchema,
  }, withLogging("get_video_comments", getVideoComments));

  server.registerTool("get_video_transcript", {
    description:
      "Get YouTube video transcript/captions (manual or auto-generated) with timestamps. Use 'lang' to pick a language code (e.g. 'en', 'id'), or omit it to get the first manual track (else the first auto-generated one); get_transcript_languages lists the codes. Returns both timestamped and plain text versions, paginated with startSegment/nextStartSegment. available=false with reason NO_CAPTIONS or LANGUAGE_UNAVAILABLE when captions are absent; access problems (ACCESS_BLOCKED etc.) are errors.",
    inputSchema: getVideoTranscriptSchema.shape,
    outputSchema: getVideoTranscriptOutputSchema,
  }, withLogging("get_video_transcript", getVideoTranscript));

  server.registerTool("search_youtube", {
    description:
      "Search YouTube videos by query. Returns up to 50 results with title, channel, views, duration, and URL. Supports filtering by uploadDate (today/week/month/year) and videoDuration (short/medium/long), and sorting by relevance, date, viewCount, or rating.",
    inputSchema: searchYoutubeSchema.shape,
    outputSchema: searchYoutubeOutputSchema,
  }, withLogging("search_youtube", searchYoutube));

  server.registerTool("get_transcript_languages", {
    description:
      "List all available caption/transcript languages for a YouTube video. Returns language codes and names for both manual and auto-generated captions. Call this first to discover available languages before fetching a transcript.",
    inputSchema: getTranscriptLanguagesSchema.shape,
    outputSchema: getTranscriptLanguagesOutputSchema,
  }, withLogging("get_transcript_languages", getTranscriptLanguages));

  server.registerTool("get_video_download_url", {
    description:
      "Get a signed DIRECT download URL (video+audio in one file) for a YouTube video. Consumers fetch the URL themselves (curl/wget); the server does not proxy or store files. URL expires in ~6 hours. Input: video URL or ID; optional quality ('best' recommended, 'bestefficiency', or '360p'/'720p'...) and format ('mp4'|'webm'|'any'). NOTE: direct links are muxed, so 'best' is typically 360p; higher resolutions are adaptive-only and need client-side merging. Chain: get the video from search_youtube, get_video_info, or get_playlist_videos.",
    inputSchema: getVideoDownloadUrlSchema.shape,
    outputSchema: getVideoDownloadUrlOutputSchema,
  }, withLogging("get_video_download_url", getVideoDownloadUrl));

  server.registerTool("list_channel_playlists", {
    description:
      "List a channel's playlists (~30 per page, paginated with page + hasMore). Input: channel URL (youtube.com/@handle, /c/name, /user/name, /channel/UC...), bare @handle, or UC... channel ID. Returns per playlist: playlistId, title, videoCount (null when not shown), url. Chain: use get_playlist_videos with a returned playlistId to list its videos, then get_video_info / get_video_transcript / get_video_comments / get_video_download_url per video.",
    inputSchema: listChannelPlaylistsSchema.shape,
    outputSchema: listChannelPlaylistsOutputSchema,
  }, withLogging("list_channel_playlists", listChannelPlaylists));

  server.registerTool("get_playlist_videos", {
    description:
      "List the videos of a YouTube playlist in order, paginated (maxResults per page, default 25; use page + hasMore). Shorts and non-video entries are filtered out. Input: playlist URL (must contain list=...) or playlist ID (PL..., OL..., RD...). Returns playlist title/totalVideos plus per video: videoId, title, url, duration, channelName. Chain: get a playlistId from list_channel_playlists or search_youtube; then use get_video_info / get_video_transcript / get_video_comments / get_video_download_url on any returned video.",
    inputSchema: getPlaylistVideosSchema.shape,
    outputSchema: getPlaylistVideosOutputSchema,
  }, withLogging("get_playlist_videos", getPlaylistVideos));

  return server;
}

async function startStdio() {
  // stdout carries MCP messages only. Route any dependency's console output to stderr.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("YouTube MCP server running on stdio");

  // The client closing stdin (or a signal) ends the session: abort in-flight
  // upstream work, close the transport, and exit.
  let shuttingDown = false;
  const shutdown = (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { reason: why });
    abortAll();
    closeClient();
    server.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.stdin.on("end", () => shutdown("stdin closed"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function startHttp() {
  const port = parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";
  const apiToken = process.env.API_TOKEN;

  const app = createMcpExpressApp({ host });
  // Tailscale Funnel fronts this endpoint and adds X-Forwarded-For; without
  // trust proxy, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
  app.set("trust proxy", 1);

  // Optional bearer token authentication
  if (apiToken) {
    app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers["authorization"];
      if (!authHeader || authHeader !== `Bearer ${apiToken}`) {
        res.status(401).json({ error: "Unauthorized: invalid or missing API token" });
        return;
      }
      next();
    });
    logger.info("HTTP mode: bearer token authentication enabled");
  } else {
    logger.warn("HTTP mode: API_TOKEN not set, endpoint is unauthenticated");
  }

  // Rate limit: 60 requests/min per IP
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
  app.use("/mcp", limiter);

  // Per-session transport map for stateful connections
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.all("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId: string) => {
          transports.set(sessionId, transport);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const mcpServer = createServer();
      await mcpServer.connect(transport);

      await transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("MCP request error", { error: msg });
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  return new Promise<void>((_resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      logger.info(`YouTube MCP server running on http://${host}:${port}/mcp`);
    });

    httpServer.on("error", reject);

    const shutdown = () => {
      logger.info("Shutting down...");
      abortAll();
      closeClient();
      httpServer.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

const useHttp =
  process.argv.includes("--http") ||
  process.env.TRANSPORT === "http";

if (useHttp) {
  startHttp().catch((error) => {
    logger.error("Fatal error", { error: String(error) });
    process.exit(1);
  });
} else {
  startStdio().catch((error) => {
    logger.error("Fatal error", { error: String(error) });
    process.exit(1);
  });
}
