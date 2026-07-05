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
import { closeClient } from "./utils/youtube-api.js";
import { logger, withLogging } from "./utils/logger.js";
import { randomUUID } from "node:crypto";

function createServer(): McpServer {
  const server = new McpServer({
    name: "youtube-mcp",
    version: "1.0.0",
  });

  server.registerTool("get_video_info", {
    description:
      "Get YouTube video metadata: title, views, likes, comment count, upload date, duration, tags, and description. Input: YouTube URL or video ID. Returns error message if video is private, deleted, or unavailable.",
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
      "Get YouTube video transcript/captions (manual or auto-generated) with timestamps. Use 'lang' to specify language code (e.g. 'en', 'id'). Returns both timestamped and plain text versions. Returns error if captions are unavailable.",
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

  return server;
}

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("YouTube MCP server running on stdio");
}

function startHttp() {
  const port = parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";
  const apiToken = process.env.API_TOKEN;

  const app = createMcpExpressApp({ host });

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
