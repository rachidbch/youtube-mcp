import { z } from "zod";
import { errorResult, YouTubeError } from "../utils/errors.js";
import { parseVideoId } from "../utils/parse-video-id.js";
import { fetchVideoInfo } from "../utils/youtube-api.js";

export const getVideoInfoSchema = z.object({
  video: z
    .string()
    .min(1, "Video URL or ID is required")
    .trim()
    .describe("YouTube video URL or video ID"),
});

export const getVideoInfoOutputSchema = {
  videoId: z.string(),
  title: z.string(),
  description: z.string().nullable().describe("null when YouTube did not provide a description; empty string when it is empty"),
  channelName: z.string().nullable(),
  channelId: z.string().nullable(),
  uploadedAt: z.string().nullable().describe("Display text such as 'Sep 14, 2017' or 'Premiered May 27, 2020'"),
  duration: z.string().nullable().describe("Human-readable duration, e.g. '1m 21s'; null when unknown or live"),
  durationSeconds: z.number().int().min(1).nullable().describe("Duration in seconds; null when unknown or live"),
  viewCount: z.string().nullable(),
  likeCount: z.string().nullable(),
  commentCount: z.string().nullable(),
  tags: z.array(z.string()),
  thumbnailUrl: z.string().nullable(),
};

export async function getVideoInfo(
  args: z.infer<typeof getVideoInfoSchema>,
  extra?: { signal?: AbortSignal }
) {
  let videoId: string;
  try {
    videoId = parseVideoId(args.video);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(new YouTubeError("INVALID_INPUT", `Invalid video: ${msg}`));
  }

  try {
    const info = await fetchVideoInfo(videoId, extra?.signal);
    const structuredContent = { ...info };
    const show = (v: string | null) => (v === null ? "unknown" : isNaN(Number(v)) ? v : Number(v).toLocaleString());

    const text = [
      `📹 ${info.title}`,
      ``,
      `Channel: ${info.channelName ?? "unknown"}`,
      `Uploaded: ${info.uploadedAt ?? "unknown"}`,
      `Duration: ${info.duration ?? "unknown"}`,
      `Views: ${show(info.viewCount)}`,
      `Likes: ${show(info.likeCount)}`,
      `Comments: ${show(info.commentCount)}`,
      ``,
      `Tags: ${info.tags.length > 0 ? info.tags.join(", ") : "none"}`,
      `Thumbnail: ${info.thumbnailUrl ?? "unknown"}`,
      ``,
      `Description:`,
      info.description ?? "(unknown)",
    ].join("\n");

    return {
      content: [{ type: "text" as const, text }],
      structuredContent,
    };
  } catch (err: unknown) {
    return errorResult(err);
  }
}
