import { z } from "zod";
import { errorResult, YouTubeError } from "../utils/errors.js";
import { parseVideoId } from "../utils/parse-video-id.js";
import { fetchVideoDownloadUrl } from "../utils/youtube-api.js";

export const getVideoDownloadUrlSchema = z.object({
  video: z
    .string()
    .min(1, "Video URL or ID is required")
    .trim()
    .describe("YouTube video URL or video ID"),
  quality: z
    .string()
    .default("best")
    .describe("Video quality: 'best' (recommended), 'bestefficiency', or a height like '360p', '720p'. NOTE: direct single-file links are muxed, so 'best' is typically 360p for most videos; higher resolutions are adaptive-only (separate audio/video) and need client-side merging."),
  format: z
    .enum(["mp4", "webm", "any"])
    .default("mp4")
    .describe("Container format for the direct link"),
});

export const getVideoDownloadUrlOutputSchema = {
  videoId: z.string(),
  title: z.string().nullable(),
  url: z.string().describe("Signed direct download URL (video+audio in one file)"),
  mimeType: z.string().nullable(),
  fileSize: z.number().nullable().describe("Size in bytes when YouTube reports it; null otherwise"),
  qualityLabel: z.string().nullable().describe("e.g. '360p'"),
  expiresNote: z.string(),
};

const EXPIRES_NOTE =
  "Signed URL extracted from YouTube's player; valid for roughly 6 hours after generation. Download it yourself (e.g. curl -o file '<url>'); the server does not proxy or store files.";

export async function getVideoDownloadUrl(
  args: z.infer<typeof getVideoDownloadUrlSchema>,
  extra?: { signal?: AbortSignal },
) {
  try {
    parseVideoId(args.video); // early INVALID_INPUT, before any network call
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(new YouTubeError("INVALID_INPUT", `Invalid video: ${msg}`));
  }

  try {
    const videoId = parseVideoId(args.video);
    const info = await fetchVideoDownloadUrl(videoId, args.quality, args.format, extra?.signal);
    const result = { ...info, expiresNote: EXPIRES_NOTE };

    const sizeMb = info.fileSize !== null ? (info.fileSize / 1_000_000).toFixed(1) : "?";
    const text = [
      `⬇️ ${info.title ?? info.videoId} — direct download link`,
      ``,
      `Quality: ${info.qualityLabel ?? "unknown"} | Format: ${info.mimeType ?? "unknown"} | Size: ${sizeMb} MB`,
      ``,
      info.url,
      ``,
      EXPIRES_NOTE,
    ].join("\n");

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: result,
    };
  } catch (err: unknown) {
    return errorResult(err);
  }
}
