import { z } from "zod";
import { errorResult, YouTubeError } from "../utils/errors.js";
import { parsePlaylistId } from "../utils/parse-playlist-id.js";
import { fetchPlaylistVideos } from "../utils/youtube-api.js";

export const getPlaylistVideosSchema = z.object({
  playlist: z
    .string()
    .min(1, "Playlist URL or ID is required")
    .trim()
    .describe("YouTube playlist URL (must contain list=...) or playlist ID (PL..., OL..., RD...)"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Number of videos per page (1-100). YouTube serves ~100 videos per underlying page."),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Page number for pagination. Use hasMore in the response to know if more pages exist."),
});

export const getPlaylistVideosOutputSchema = {
  playlistId: z.string(),
  title: z.string().nullable(),
  totalVideos: z.number().int().nullable().describe("YouTube's declared total; can exceed the videos actually listable, because deleted/private/blocked entries stay in the count but are never served"),
  videos: z.array(z.object({
    videoId: z.string(),
    title: z.string(),
    url: z.string().describe("https://www.youtube.com/watch?v=<id>"),
    duration: z.string().nullable().describe("Human-readable duration, e.g. '6m 30s'; null when unknown or live"),
    channelName: z.string().nullable(),
  })),
  page: z.number().int().min(1),
  hasMore: z.boolean(),
  totalFetched: z.number().int().min(0),
};

export async function getPlaylistVideos(
  args: z.infer<typeof getPlaylistVideosSchema>,
  extra?: { signal?: AbortSignal },
) {
  try {
    parsePlaylistId(args.playlist); // early INVALID_INPUT, before any network call
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(new YouTubeError("INVALID_INPUT", `Invalid playlist: ${msg}`));
  }

  try {
    const result = await fetchPlaylistVideos(args.playlist, args.maxResults, args.page, extra?.signal);

    const text = [
      `🎬 Playlist: ${result.title ?? result.playlistId}` +
        (result.totalVideos === null ? "" : ` — ${result.totalVideos} video(s) total`),
      `Page ${result.page} — ${result.videos.length} video(s)` +
        (result.hasMore ? ` (more available, use page=${result.page + 1})` : " (last page)"),
      ``,
      ...result.videos.map(
        (v) => `- ${v.title} — ${v.duration ?? "unknown duration"} — ${v.channelName ?? "unknown channel"} — ${v.url}`,
      ),
    ].join("\n");

    const structuredContent = {
      playlistId: result.playlistId,
      title: result.title,
      totalVideos: result.totalVideos,
      videos: result.videos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        url: v.url,
        duration: v.duration,
        channelName: v.channelName,
      })),
      page: result.page,
      hasMore: result.hasMore,
      totalFetched: result.totalFetched,
    };

    return {
      content: [{ type: "text" as const, text }],
      structuredContent,
    };
  } catch (err: unknown) {
    return errorResult(err);
  }
}
