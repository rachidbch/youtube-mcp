import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import { searchVideos } from "../utils/youtube-api.js";

export const searchYoutubeSchema = z.object({
  query: z
    .string()
    .min(1, "Search query is required")
    .trim()
    .describe("Search query string"),
  maxResults: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of results to return (1-50)"),
  sortBy: z
    .enum(["relevance", "date", "viewCount", "rating"])
    .default("relevance")
    .describe(
      "Sort order: 'relevance' (default) or 'viewCount' (most popular). YouTube search cannot sort by 'date' (results stay in relevance order) or 'rating' (sorted by popularity instead); both return a warning."
    ),
  uploadDate: z
    .enum(["any", "hour", "today", "week", "month", "year"])
    .default("any")
    .describe(
      "Filter by upload date: 'any', 'today', 'week', 'month', 'year'. 'hour' is not available on YouTube and is applied as 'today' with a warning."
    ),
  videoDuration: z
    .enum(["any", "short", "medium", "long"])
    .default("any")
    .describe(
      "Filter by duration: 'any', 'short' (<3min), 'medium' (3-20min), 'long' (>20min)"
    ),
});

const searchResultSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  description: z.string(),
  channelTitle: z.string(),
  publishedAt: z.string(),
  thumbnailUrl: z.string(),
  viewCount: z.string(),
  duration: z.string(),
});

export const searchYoutubeOutputSchema = {
  query: z.string(),
  resultCount: z.number().int().min(0),
  sortBy: z.enum(["relevance", "date", "viewCount", "rating"]),
  uploadDate: z.enum(["any", "hour", "today", "week", "month", "year"]),
  videoDuration: z.enum(["any", "short", "medium", "long"]),
  results: z.array(searchResultSchema),
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .optional()
    .describe("Requested options that YouTube search could not apply exactly"),
};

export async function searchYoutube(
  args: z.infer<typeof searchYoutubeSchema>,
  extra?: { signal?: AbortSignal }
) {
  let page: Awaited<ReturnType<typeof searchVideos>>;
  try {
    page = await searchVideos({
      query: args.query,
      maxResults: args.maxResults,
      sortBy: args.sortBy,
      uploadDate: args.uploadDate,
      videoDuration: args.videoDuration,
    }, extra?.signal);
  } catch (err: unknown) {
    return errorResult(err);
  }

  const { results, warnings } = page;
  const warningFields = warnings.length > 0 ? { warnings } : {};
  const warningLines = warnings.map((w) => `⚠️ ${w.message}`);

  if (results.length === 0) {
    const structuredContent = {
      query: args.query,
      resultCount: 0,
      sortBy: args.sortBy,
      uploadDate: args.uploadDate,
      videoDuration: args.videoDuration,
      results: [],
      ...warningFields,
    };

    return {
      content: [
        { type: "text" as const, text: ["No results found for this search.", ...warningLines].join("\n") },
      ],
      structuredContent,
    };
  }

  const lines: string[] = [
    `🔍 Found ${results.length} result(s) for "${args.query}":\n`,
    ...warningLines.map((l) => `${l}\n`),
  ];

  for (const [i, r] of results.entries()) {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   Channel: ${r.channelTitle}`);
    if (r.publishedAt) lines.push(`   Published: ${r.publishedAt}`);
    if (r.viewCount) lines.push(`   Views: ${r.viewCount}`);
    if (r.duration) lines.push(`   Duration: ${r.duration}`);
    lines.push(`   Video ID: ${r.videoId}`);
    lines.push(`   URL: https://www.youtube.com/watch?v=${r.videoId}`);
    if (r.description) {
      const desc =
        r.description.length > 150
          ? r.description.slice(0, 150) + "..."
          : r.description;
      lines.push(`   Description: ${desc}`);
    }
    lines.push("");
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    structuredContent: {
      query: args.query,
      resultCount: results.length,
      sortBy: args.sortBy,
      uploadDate: args.uploadDate,
      videoDuration: args.videoDuration,
      results,
      ...warningFields,
    },
  };
}
