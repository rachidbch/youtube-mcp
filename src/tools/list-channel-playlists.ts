import { z } from "zod";
import { errorResult, YouTubeError } from "../utils/errors.js";
import { parseChannelRef } from "../utils/parse-channel-id.js";
import { fetchChannelPlaylists } from "../utils/youtube-api.js";

export const listChannelPlaylistsSchema = z.object({
  channel: z
    .string()
    .min(1, "Channel URL, @handle, or channel ID is required")
    .trim()
    .describe("YouTube channel: URL (youtube.com/@handle, /c/name, /user/name, /channel/UC...), bare @handle, or UC... channel ID"),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Page number for pagination (~30 playlists per page). Use hasMore in the response to know if more pages exist."),
});

export const listChannelPlaylistsOutputSchema = {
  playlists: z.array(z.object({
    playlistId: z.string(),
    title: z.string(),
    videoCount: z.number().int().nullable().describe("null when YouTube did not show a count for this playlist"),
    url: z.string(),
  })),
  page: z.number().int().min(1),
  hasMore: z.boolean(),
  totalFetched: z.number().int().min(0),
};

export async function listChannelPlaylists(
  args: z.infer<typeof listChannelPlaylistsSchema>,
  extra?: { signal?: AbortSignal },
) {
  try {
    parseChannelRef(args.channel); // early INVALID_INPUT, before any network call
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(new YouTubeError("INVALID_INPUT", `Invalid channel: ${msg}`));
  }

  try {
    const result = await fetchChannelPlaylists(args.channel, args.page, extra?.signal);

    const text = [
      `📋 Channel playlists — page ${result.page} — ${result.playlists.length} playlist(s)` +
        (result.hasMore ? ` (more available, use page=${result.page + 1})` : " (last page)"),
      ``,
      ...result.playlists.map(
        (p) => `- ${p.title} (${p.videoCount === null ? "unknown count" : `${p.videoCount} video(s)`}) — ${p.playlistId} — ${p.url}`,
      ),
    ].join("\n");

    const structuredContent = {
      playlists: result.playlists.map((p) => ({
        playlistId: p.playlistId,
        title: p.title,
        videoCount: p.videoCount,
        url: p.url,
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
