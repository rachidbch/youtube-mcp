import { z } from "zod";
import { errorResult, YouTubeError } from "../utils/errors.js";
import { fetchMyPlaylists } from "../utils/google-account.js";

export const listMyPlaylistsSchema = z.object({
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Page number for pagination (50 playlists per page; most accounts fit on page 1). Use hasMore in the response to know if more pages exist."),
});

export const listMyPlaylistsOutputSchema = {
  playlists: z.array(z.object({
    playlistId: z.string(),
    title: z.string(),
    videoCount: z.number().int().nullable(),
    privacyStatus: z.string().nullable().describe("public | unlisted | private"),
    url: z.string(),
    kind: z.enum(["created", "liked", "uploads"]).describe("created = your playlist; liked = Liked videos; uploads = channel uploads"),
  })),
  page: z.number().int().min(1),
  hasMore: z.boolean(),
  totalFetched: z.number().int().min(0),
  /** Watch Later is not exposed by Google's API to any client; it is absent by design. */
  watchLaterNote: z.string(),
};

const WATCH_LATER_NOTE =
  "Google's API never exposes the Watch Later playlist to any client; it cannot be listed here.";

export async function listMyPlaylists(
  args: z.infer<typeof listMyPlaylistsSchema>,
  extra?: { signal?: AbortSignal },
) {
  try {
    const result = await fetchMyPlaylists(args.page, extra?.signal);

    const text = [
      `📋 Your playlists — page ${result.page} — ${result.playlists.length} playlist(s)` +
        (result.hasMore ? ` (more available, use page=${result.page + 1})` : " (last page)"),
      ``,
      ...result.playlists.map(
        (p) =>
          `- ${p.title} (${p.videoCount === null ? "unknown count" : `${p.videoCount} video(s)`}, ${p.privacyStatus ?? "?"}, ${p.kind}) — ${p.playlistId} — ${p.url}`,
      ),
      ``,
      `Note: ${WATCH_LATER_NOTE}`,
    ].join("\n");

    const structuredContent = {
      playlists: result.playlists.map((p) => ({
        playlistId: p.playlistId,
        title: p.title,
        videoCount: p.videoCount,
        privacyStatus: p.privacyStatus,
        url: p.url,
        kind: p.kind,
      })),
      page: result.page,
      hasMore: result.hasMore,
      totalFetched: result.totalFetched,
      watchLaterNote: WATCH_LATER_NOTE,
    };

    return {
      content: [{ type: "text" as const, text }],
      structuredContent,
    };
  } catch (err: unknown) {
    return errorResult(err);
  }
}
