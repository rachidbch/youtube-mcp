import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import { fetchMyFeed } from "../utils/youtube-feed.js";

export const getMyFeedSchema = z.object({
  maxResults: z.number().int().min(1).max(50).default(20).describe("Maximum recommendations to return (1-50)."),
});

export const getMyFeedOutputSchema = {
  videos: z.array(z.object({
    videoId: z.string(),
    title: z.string(),
    url: z.string(),
    channelName: z.string().nullable(),
  })),
  note: z.string().nullable().describe("Present when the feed came back empty or partially parsed"),
};

export async function getMyFeedTool(args: z.infer<typeof getMyFeedSchema>, extra?: { signal?: AbortSignal }) {
  try {
    const { videos, note } = await fetchMyFeed(args.maxResults, extra?.signal);
    const text = [
      `📺 Your home feed — ${videos.length} recommendation(s)${note ? ` (note: ${note})` : ""}:`,
      ``,
      ...videos.map((v) => `- ${v.title} — ${v.channelName ?? "unknown channel"} — ${v.url}`),
    ].join("\n");
    const structuredContent = { videos: videos.map((v) => ({ ...v })), note };
    return { content: [{ type: "text" as const, text }], structuredContent };
  } catch (err: unknown) {
    return errorResult(err);
  }
}
