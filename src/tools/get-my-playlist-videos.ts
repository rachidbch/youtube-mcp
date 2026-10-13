import { z } from "zod";
import { errorResult, YouTubeError } from "../utils/errors.js";
import { parsePlaylistId } from "../utils/parse-playlist-id.js";
import { fetchMyPlaylistVideos } from "../utils/google-account.js";

export const getMyPlaylistVideosSchema = z.object({
  playlist: z
    .string()
    .min(1, "Playlist ID is required")
    .trim()
    .describe("One of YOUR playlist IDs (from list_my_playlists), including Liked (LL...) or Uploads (UU...) IDs. Google's API does not serve Watch Later."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Number of videos per page (1-100)."),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Page number for pagination. Use hasMore in the response to know if more pages exist."),
});

export const getMyPlaylistVideosOutputSchema = {
  playlistId: z.string(),
  title: z.null(),
  totalVideos: z.null(),
  videos: z.array(z.object({
    videoId: z.string(),
    title: z.string(),
    url: z.string(),
    position: z.number().int().describe("Position in the playlist (0-based, YouTube's own ordering)"),
    channelName: z.string().nullable(),
    addedAt: z.string().nullable().describe("When the video was added to the playlist (ISO date)"),
  })),
  page: z.number().int().min(1),
  hasMore: z.boolean(),
  totalFetched: z.number().int().min(0),
};

export async function getMyPlaylistVideos(
  args: z.infer<typeof getMyPlaylistVideosSchema>,
  extra?: { signal?: AbortSignal },
) {
  let playlistId: string;
  try {
    playlistId = parsePlaylistId(args.playlist); // early INVALID_INPUT, before any network call
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(new YouTubeError("INVALID_INPUT", `Invalid playlist: ${msg}`));
  }

  try {
    const result = await fetchMyPlaylistVideos(playlistId, args.maxResults, args.page, extra?.signal);

    const text = [
      `🎬 Your playlist ${result.playlistId} — page ${result.page} — ${result.videos.length} video(s)` +
        (result.hasMore ? ` (more available, use page=${result.page + 1})` : " (last page)"),
      ``,
      ...result.videos.map((v) => `- ${v.title} — ${v.channelName ?? "unknown channel"} — ${v.url}`),
    ].join("\n");

    const structuredContent = {
      playlistId: result.playlistId,
      title: result.title,
      totalVideos: result.totalVideos,
      videos: result.videos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        url: v.url,
        position: v.position,
        channelName: v.channelName,
        addedAt: v.addedAt,
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
