import { z } from "zod";
import { errorResult, YouTubeError } from "../utils/errors.js";
import { parseVideoId } from "../utils/parse-video-id.js";
import { fetchComments } from "../utils/youtube-api.js";

export const getVideoCommentsSchema = z.object({
  video: z
    .string()
    .min(1, "Video URL or ID is required")
    .trim()
    .describe("YouTube video URL or video ID"),
  maxResults: z
    .number()
    .min(1)
    .max(20)
    .default(20)
    .describe("Number of comment threads per page (1-20, YouTube returns ~20 per page)"),
  sortBy: z
    .enum(["time", "relevance"])
    .default("relevance")
    .describe("Sort order: 'relevance' (top comments) or 'time' (newest first)"),
  page: z
    .number()
    .min(1)
    .default(1)
    .describe("Page number for pagination. Each page returns up to 20 comment threads. Use hasMore in the response to know if more pages exist."),
});

const commentReplySchema = z.object({
  author: z.string(),
  authorChannelUrl: z.string(),
  text: z.string(),
  likeCount: z.string(),
  publishedAt: z.string(),
});

const commentThreadSchema = z.object({
  author: z.string(),
  authorChannelUrl: z.string(),
  text: z.string(),
  likeCount: z.string(),
  publishedAt: z.string(),
  replyCount: z.string(),
  replies: z.array(commentReplySchema),
});

export const getVideoCommentsOutputSchema = {
  videoId: z.string(),
  page: z.number().int().min(1),
  sortBy: z.enum(["time", "relevance"]),
  totalFetched: z.number().int().min(0),
  threadCount: z.number().int().min(0),
  hasMore: z.boolean(),
  threads: z.array(commentThreadSchema),
};

export async function getVideoComments(
  args: z.infer<typeof getVideoCommentsSchema>,
  extra?: { signal?: AbortSignal }
) {
  let videoId: string;
  try {
    videoId = parseVideoId(args.video);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(new YouTubeError("INVALID_INPUT", `Invalid video: ${msg}`));
  }

  let result: Awaited<ReturnType<typeof fetchComments>>;
  try {
    result = await fetchComments(videoId, args.maxResults, args.sortBy, args.page, extra?.signal);
  } catch (err: unknown) {
    return errorResult(err);
  }

  if (result.threads.length === 0) {
    const structuredContent = {
      videoId,
      page: result.page,
      sortBy: args.sortBy,
      totalFetched: result.totalFetched,
      threadCount: 0,
      hasMore: result.hasMore,
      threads: [],
    };

    return {
      content: [{ type: "text" as const, text: "No comments found for this video." }],
      structuredContent,
    };
  }

  const MAX_REPLIES = 5;
  const lines: string[] = [
    `💬 Page ${result.page} — ${result.threads.length} comment thread(s)${result.hasMore ? ` (more available, use page=${result.page + 1})` : " (last page)"}:\n`,
  ];

  for (const [i, comment] of result.threads.entries()) {
    lines.push(`--- Comment ${i + 1} ---`);
    lines.push(`Author: ${comment.author}`);
    lines.push(`Date: ${comment.publishedAt}`);
    lines.push(`Likes: ${comment.likeCount}`);
    lines.push(`Text: ${comment.text}`);

    if (comment.replies.length > 0) {
      const displayReplies = comment.replies.slice(0, MAX_REPLIES);
      const truncatedReplies = comment.replies.length > MAX_REPLIES;
      lines.push(`  Replies (showing ${displayReplies.length} of ${comment.replyCount}${truncatedReplies ? `, capped at ${MAX_REPLIES}` : ""}):`);
      for (const reply of displayReplies) {
        lines.push(`    → ${reply.author} (${reply.publishedAt}, ${reply.likeCount} likes)`);
        lines.push(`      ${reply.text}`);
      }
    }
    lines.push("");
  }

  const structuredContent = {
    videoId,
    page: result.page,
    sortBy: args.sortBy,
    totalFetched: result.totalFetched,
    threadCount: result.threads.length,
    hasMore: result.hasMore,
    threads: result.threads,
  };

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    structuredContent,
  };
}
