import Innertube from "youtubei.js";
import {
  fetchTranscript,
  listLanguages,
  type TranscriptSegment,
} from "youtube-transcript-plus";
import {
  abortable,
  contextFetch,
  currentContext,
  readTextLimited,
  runInContext,
  runWithDeadline,
  type CallContext,
} from "./abort.js";
import { config } from "./config.js";
import {
  errorFromHttpStatus,
  errorFromPlayability,
  YouTubeError,
} from "./errors.js";
import { logger } from "./logger.js";
import { TTLCache } from "./ttl-cache.js";

// SearchFilters type from youtubei.js (not directly exported)
interface SearchFilters {
  upload_date?: "all" | "today" | "week" | "month" | "year";
  type?: "all" | "video" | "shorts" | "channel" | "playlist" | "movie";
  duration?: "all" | "over_twenty_mins" | "under_three_mins" | "three_to_twenty_mins";
  prioritize?: "relevance" | "popularity";
}

// --- Innertube client singleton ---
// Initialization is shared by concurrent calls. It has its own deadline and is
// aborted once every waiting call has given up, so no orphaned init keeps running.
let _innertube: Innertube | null = null;
let _retrievePlayer = true;
let _init: { promise: Promise<Innertube>; controller: AbortController; waiters: number } | null = null;

function startInit(): NonNullable<typeof _init> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new YouTubeError("TIMEOUT", `YouTube client initialization timed out after ${config.initTimeoutMs}ms`)),
    config.initTimeoutMs,
  );
  const state = {
    controller,
    waiters: 0,
    promise: runInContextWithReason(controller.signal, () =>
      // Keep the default retrieve_player: without the player script's signature
      // timestamp, YouTube reports available videos as UNPLAYABLE ("Video unavailable")
      // and omits caption tracks. Metadata never reads formats or streaming data.
      Innertube.create({ fetch: contextFetch as typeof fetch, retrieve_player: _retrievePlayer }),
    )
      .then((client) => {
        _innertube = client;
        return client;
      })
      .finally(() => {
        clearTimeout(timer);
        if (_init === state) _init = null;
      }),
  };
  state.promise.catch(() => {}); // observed by waiters; avoid unhandled rejection
  return state;
}

/**
 * Run fn in a context bound to signal; if aborted, reject with the abort reason.
 * youtubei.js swallows failures of its session bootstrap requests (including aborts)
 * and falls back to a locally generated session, so a resolved result is also
 * discarded when the signal fired meanwhile.
 */
async function runInContextWithReason<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await runInContext({ signal }, fn);
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    throw err;
  }
  if (signal.aborted) throw signal.reason;
  return result;
}

async function getClient(signal: AbortSignal): Promise<Innertube> {
  if (_innertube) return _innertube;
  const state = (_init ??= startInit());
  state.waiters++;
  try {
    return await abortable(state.promise, signal);
  } finally {
    state.waiters--;
    if (signal.aborted && state.waiters === 0 && _init === state) {
      state.controller.abort(signal.reason);
    }
  }
}

export function closeClient(): void {
  _init?.controller.abort(new YouTubeError("CANCELLED", "Server is shutting down"));
  _init = null;
  _innertube = null;
}

// --- Caches ---
const CACHE_MAX_ENTRIES = {
  videoInfo: 500,
  comments:  200,
  search:    200,
};
const videoInfoCache = new TTLCache<VideoInfo>(CACHE_MAX_ENTRIES.videoInfo);
// commentsCache declared after CommentPage interface below
const searchCache = new TTLCache<SearchPage>(CACHE_MAX_ENTRIES.search);
const CACHE_TTL = {
  videoInfo: 30 * 60 * 1000,   // 30 minutes
  comments:  10 * 60 * 1000,   // 10 minutes
  search:    15 * 60 * 1000,   // 15 minutes
};

/**
 * Test hook: drop cached results and the client. Offline tests pass
 * retrievePlayer: false because a fake fetch cannot serve the real player script.
 */
export function resetForTesting(options: { retrievePlayer?: boolean } = {}): void {
  _retrievePlayer = options.retrievePlayer ?? true;
  closeClient();
  videoInfoCache.clear();
  commentsCache.clear();
  searchCache.clear();
}

/** youtubei.js throws InnertubeError for its own failures; keep its message as the upstream reason. */
function wrapUpstream(err: unknown, what: string): never {
  if (err instanceof YouTubeError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  throw new YouTubeError("UPSTREAM_ERROR", `${what}: ${msg}`);
}

export interface VideoInfo {
  videoId: string;
  title: string;
  description: string | null;
  channelName: string | null;
  channelId: string | null;
  uploadedAt: string | null;
  duration: string | null;
  durationSeconds: number | null;
  viewCount: string | null;
  likeCount: string | null;
  commentCount: string | null;
  tags: string[];
  thumbnailUrl: string | null;
}

export function fetchVideoInfo(videoId: string, signal?: AbortSignal): Promise<VideoInfo> {
  const cached = videoInfoCache.get(videoId);
  if (cached) return Promise.resolve(cached);

  return runWithDeadline(signal, config.requestTimeoutMs, `get_video_info(${videoId})`, async (s) => {
    const yt = await getClient(s);

    let info: Awaited<ReturnType<typeof yt.getInfo>>;
    try {
      info = await yt.getInfo(videoId);
    } catch (err) {
      // youtubei.js throws for playability ERROR, attaching the status as `info`.
      const playability = (err as { info?: { status?: unknown; reason?: unknown } }).info;
      if (typeof playability?.status === "string") {
        const classified = errorFromPlayability(
          { status: playability.status, reason: typeof playability.reason === "string" ? playability.reason : undefined },
          videoId,
        );
        if (classified) throw classified;
      }
      wrapUpstream(err, "Failed to fetch video info");
    }

    const basic = info.basic_info;
    const playabilityError = errorFromPlayability(info.playability_status, videoId);
    if (!basic.title) {
      if (playabilityError) throw playabilityError;
      throw new YouTubeError("PARSE_ERROR", `YouTube returned no title for video ${videoId}`, {
        playabilityStatus: info.playability_status?.status,
      });
    }
    if (basic.id !== videoId) {
      throw new YouTubeError("PARSE_ERROR", `YouTube returned metadata for video ${basic.id ?? "(no ID)"} instead of ${videoId}`);
    }
    if (playabilityError) {
      // Metadata is available even though playback is not; report it, but don't fail.
      logger.warn("Video metadata returned with non-OK playability", { videoId, ...playabilityError.upstream });
    }

    const durationSeconds = typeof basic.duration === "number" && basic.duration > 0 ? basic.duration : null;

    const result: VideoInfo = {
      videoId,
      title: basic.title,
      description: basic.short_description ?? null,
      channelName: basic.channel?.name || basic.author || null,
      channelId: basic.channel?.id || basic.channel_id || null,
      uploadedAt: info.primary_info?.published?.toString() || null,
      duration: durationSeconds === null ? null : formatDuration(durationSeconds),
      durationSeconds,
      viewCount: basic.view_count?.toString() ?? null,
      likeCount: basic.like_count?.toString() ?? null,
      commentCount: info.comments_entry_point_header?.comment_count?.toString() || null,
      tags: basic.tags || basic.keywords || [],
      thumbnailUrl: basic.thumbnail?.[0]?.url || null,
    };

    videoInfoCache.set(videoId, result, CACHE_TTL.videoInfo);
    return result;
  });
}

export interface CommentThread {
  author: string;
  authorChannelUrl: string;
  text: string;
  likeCount: string;
  publishedAt: string;
  replyCount: string;
  replies: CommentReply[];
}

export interface CommentReply {
  author: string;
  authorChannelUrl: string;
  text: string;
  likeCount: string;
  publishedAt: string;
}

export interface CommentPage {
  threads: CommentThread[];
  hasMore: boolean;
  page: number;
  totalFetched: number;
}

const commentsCache = new TTLCache<CommentPage>(CACHE_MAX_ENTRIES.comments);

export function fetchComments(
  videoId: string,
  maxResults: number = 20,
  order: "relevance" | "time" = "relevance",
  page: number = 1,
  signal?: AbortSignal
): Promise<CommentPage> {
  const cacheKey = `${videoId}:${maxResults}:${order}:${page}`;
  const cached = commentsCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  return runWithDeadline(signal, config.requestTimeoutMs, `get_video_comments(${videoId})`, async (s) => {
    const yt = await getClient(s);
    const sortBy = order === "time" ? "NEWEST_FIRST" : "TOP_COMMENTS";

    let commentsData: Awaited<ReturnType<typeof yt.getComments>>;
    try {
      commentsData = await yt.getComments(videoId, sortBy);
    } catch (err) {
      if (err instanceof Error && err.message.includes("did not have any content")) {
        throw new YouTubeError("COMMENTS_UNAVAILABLE", "Comments are disabled or unavailable for this video.", {
          reason: err.message,
        });
      }
      wrapUpstream(err, "Failed to fetch comments");
    }

    // Navigate to the requested page using getContinuation()
    // YouTube returns ~20 threads per page
    for (let p = 1; p < page; p++) {
      if (!commentsData.has_continuation) break;
      try {
        commentsData = await commentsData.getContinuation();
      } catch (err) {
        wrapUpstream(err, `Failed to load comments page ${p + 1}`);
      }
    }

    const threads: CommentThread[] = [];

    for (const thread of commentsData.contents) {
      if (threads.length >= maxResults) break;

      const comment = thread.comment;
      if (!comment) continue;

      // youtubei.js 18: replies are nested CommentThreads. Only replies YouTube
      // prepopulated are returned; fetching the rest would cost a request per thread.
      const replies: CommentReply[] = [];
      for (const replyThread of thread.replies ?? []) {
        const reply = replyThread.comment;
        if (!reply) continue;
        replies.push({
          author: reply.author?.name || "",
          authorChannelUrl: reply.author?.url || "",
          text: reply.content?.toString() || "",
          likeCount: reply.like_count || "0",
          publishedAt: reply.published_time || "",
        });
      }

      threads.push({
        author: comment.author?.name || "",
        authorChannelUrl: comment.author?.url || "",
        text: comment.content?.toString() || "",
        likeCount: comment.like_count || "0",
        publishedAt: comment.published_time || "",
        replyCount: comment.reply_count || "0",
        replies,
      });
    }

    const result: CommentPage = {
      threads,
      hasMore: commentsData.has_continuation && threads.length === maxResults,
      page,
      totalFetched: threads.length,
    };

    commentsCache.set(cacheKey, result, CACHE_TTL.comments);
    return result;
  });
}

export interface SearchResult {
  videoId: string;
  title: string;
  description: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string;
  viewCount: string;
  duration: string;
}

export interface SearchOptions {
  query: string;
  maxResults: number;
  sortBy: "relevance" | "date" | "viewCount" | "rating";
  uploadDate: "any" | "hour" | "today" | "week" | "month" | "year";
  videoDuration: "any" | "short" | "medium" | "long";
}

export interface SearchWarning {
  code: "SORT_NOT_SUPPORTED" | "SORT_APPROXIMATED" | "UPLOAD_DATE_APPROXIMATED";
  message: string;
}

export interface SearchPage {
  results: SearchResult[];
  warnings: SearchWarning[];
}

/**
 * Map tool options onto youtubei.js search filters. YouTube's filters only offer
 * upload dates from "today" up and ordering by relevance or popularity, so options
 * that cannot be applied exactly produce a warning instead of being dropped silently.
 */
export function buildSearchFilters(options: Pick<SearchOptions, "sortBy" | "uploadDate" | "videoDuration">): {
  filters: SearchFilters;
  warnings: SearchWarning[];
} {
  const filters: SearchFilters = { type: "video" };
  const warnings: SearchWarning[] = [];

  if (options.uploadDate === "hour") {
    filters.upload_date = "today";
    warnings.push({
      code: "UPLOAD_DATE_APPROXIMATED",
      message: "YouTube search has no last-hour filter; results are limited to today instead.",
    });
  } else if (options.uploadDate !== "any") {
    filters.upload_date = options.uploadDate;
  }

  if (options.videoDuration !== "any") {
    const durationMap: Record<string, SearchFilters["duration"]> = {
      short: "under_three_mins",
      medium: "three_to_twenty_mins",
      long: "over_twenty_mins",
    };
    filters.duration = durationMap[options.videoDuration];
  }

  if (options.sortBy === "viewCount") {
    filters.prioritize = "popularity";
  } else if (options.sortBy === "rating") {
    filters.prioritize = "popularity";
    warnings.push({
      code: "SORT_APPROXIMATED",
      message: "YouTube search cannot sort by rating; results are sorted by popularity instead.",
    });
  } else if (options.sortBy === "date") {
    warnings.push({
      code: "SORT_NOT_SUPPORTED",
      message: "YouTube search cannot sort by upload date; results are in relevance order. Use uploadDate to limit results to recent uploads.",
    });
  }

  return { filters, warnings };
}

export function searchVideos(
  options: SearchOptions,
  signal?: AbortSignal
): Promise<SearchPage> {
  const cacheKey = JSON.stringify(options);
  const cached = searchCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  return runWithDeadline(signal, config.requestTimeoutMs, "search_youtube", async (s) => {
    const yt = await getClient(s);
    const { filters, warnings } = buildSearchFilters(options);

    let searchResults: Awaited<ReturnType<typeof yt.search>>;
    try {
      searchResults = await yt.search(options.query, filters);
    } catch (err) {
      wrapUpstream(err, "Search failed");
    }

    const results: SearchResult[] = [];

    for (const video of searchResults.videos) {
      if (results.length >= options.maxResults) break;

      const v = video as unknown as Record<string, unknown>;
      const duration = v["duration"];
      const durationText =
        typeof duration === "object" && duration !== null
          ? String((duration as Record<string, unknown>)["text"] ?? "")
          : typeof duration === "number"
          ? formatDuration(duration)
          : "";

      results.push({
        videoId: String(v["id"] ?? ""),
        title: String((v["title"] as { toString(): string } | undefined)?.toString() ?? ""),
        description: String((v["description_snippet"] as { toString(): string } | undefined)?.toString() ?? ""),
        channelTitle: String((v["author"] as Record<string, unknown> | undefined)?.["name"] ?? ""),
        publishedAt: String((v["published"] as { toString(): string } | undefined)?.toString() ?? ""),
        thumbnailUrl: String((v["thumbnails"] as Array<Record<string, unknown>> | undefined)?.[0]?.["url"] ?? ""),
        viewCount: String((v["short_view_count"] as { toString(): string } | undefined)?.toString() ?? ""),
        duration: durationText,
      });
    }

    const page: SearchPage = { results, warnings };
    searchCache.set(cacheKey, page, CACHE_TTL.search);
    return page;
  });
}

// --- Transcripts (youtube-transcript-plus) ---
// The library collapses HTTP and playability failures into "unavailable"/"not available".
// We route its three fetches through our own hooks, which throw classified errors for
// HTTP failures and record the player response, then map the library's errors using that record.

export interface CaptionLanguage {
  languageCode: string;
  languageName: string;
  isAutoGenerated: boolean;
}

export interface CaptionTranscript {
  languageCode: string;
  isAutoGenerated: boolean | null;
  segments: TranscriptSegment[];
}

export function listCaptionLanguages(videoId: string, signal?: AbortSignal): Promise<CaptionLanguage[]> {
  return runWithDeadline(signal, config.requestTimeoutMs, `get_transcript_languages(${videoId})`, async () => {
    const ctx = currentContext()!;
    try {
      const languages = await listLanguages(videoId, transcriptConfig(ctx));
      // The library only reads name.simpleText; the ANDROID player response may use runs.
      return languages.map((l, i) => ({
        languageCode: l.languageCode,
        languageName: l.languageName !== l.languageCode ? l.languageName : ctx.captionTracks?.[i]?.name || l.languageName,
        isAutoGenerated: l.isAutoGenerated,
      }));
    } catch (err) {
      throw classifyTranscriptError(err, videoId, ctx);
    }
  });
}

/**
 * Fetch one caption track. With lang, the first track in that language; without it,
 * the first manual track, or the first automatic one if there is no manual track.
 */
export function fetchCaptionTranscript(videoId: string, lang: string | undefined, signal?: AbortSignal): Promise<CaptionTranscript> {
  return runWithDeadline(signal, config.requestTimeoutMs, `get_video_transcript(${videoId}, ${lang ?? "default"})`, async () => {
    const ctx = currentContext()!;
    let segments: TranscriptSegment[];
    try {
      segments = await fetchTranscript(videoId, transcriptConfig(ctx, lang, { manualFirst: lang === undefined }));
    } catch (err) {
      throw classifyTranscriptError(err, videoId, ctx);
    }
    if (segments.length > config.transcriptMaxSegments) {
      throw new YouTubeError(
        "LIMIT_EXCEEDED",
        `Caption track has ${segments.length} segments, above the limit of ${config.transcriptMaxSegments} (YT_TRANSCRIPT_MAX_SEGMENTS)`,
      );
    }
    // The library selects the first track whose languageCode matches, or the first track without lang.
    const track = lang === undefined ? ctx.captionTracks?.[0] : ctx.captionTracks?.find((t) => t.languageCode === lang);
    return {
      languageCode: lang ?? track?.languageCode ?? segments[0]?.lang ?? "",
      isAutoGenerated: track ? track.kind === "asr" : null,
      // Caption text is entity-escaped twice (e.g. "I&amp;#39;m"); the library decodes once.
      segments: segments.map((seg) => ({ ...seg, text: decodeHtmlEntities(seg.text) })),
    };
  });
}

// youtube-transcript-plus 2.0.0 re-exports its error classes and config types from
// extensionless paths, which TypeScript's Node16 resolution cannot follow. The
// runtime exports exist; we declare the parts we use and match errors by name.
interface FetchParams {
  url: string;
  lang?: string;
  userAgent?: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

interface TranscriptConfig {
  lang?: string;
  retries?: number;
  signal?: AbortSignal;
  videoFetch?: (params: FetchParams) => Promise<Response>;
  playerFetch?: (params: FetchParams) => Promise<Response>;
  transcriptFetch?: (params: FetchParams) => Promise<Response>;
}

type TranscriptLibraryError = Error & { lang?: string; availableLangs?: string[] };

function transcriptConfig(ctx: CallContext, lang?: string, { manualFirst = false } = {}): TranscriptConfig {
  return {
    lang,
    retries: 0,
    signal: ctx.signal,
    videoFetch: async (p) => {
      const res = await transcriptHookFetch(p);
      const finalUrl = res.url || p.url;
      if (finalUrl.includes("consent.youtube.com")) {
        await res.body?.cancel().catch(() => {});
        throw new YouTubeError("ACCESS_BLOCKED", "YouTube redirected to a cookie-consent page", {
          url: "consent.youtube.com", accessKind: "consent_required",
        });
      }
      const body = await readTextLimited(res, config.transcriptMaxBytes, "Watch page");
      if (body.includes('class="g-recaptcha"')) {
        throw new YouTubeError("ACCESS_BLOCKED", "YouTube served a CAPTCHA instead of the watch page", {
          httpStatus: res.status, url: "www.youtube.com/watch", accessKind: "rate_limited",
        });
      }
      if (!body.includes("INNERTUBE_API_KEY")) {
        throw new YouTubeError("PARSE_ERROR", "Watch page did not contain an InnerTube API key", {
          httpStatus: res.status, url: "www.youtube.com/watch",
        });
      }
      return new Response(body, { status: res.status });
    },
    playerFetch: async (p) => {
      const res = await transcriptHookFetch(p);
      const body = await readTextLimited(res, config.transcriptMaxBytes, "Player response");
      let json: {
        playabilityStatus?: { status?: string; reason?: string };
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: Array<{
              languageCode?: string;
              kind?: string;
              name?: { simpleText?: string; runs?: Array<{ text?: string }> };
            }>;
          };
        };
      };
      try {
        json = JSON.parse(body);
      } catch {
        throw new YouTubeError("PARSE_ERROR", "Player response was not valid JSON", { url: "www.youtube.com/youtubei/v1/player" });
      }
      ctx.playability = { status: json.playabilityStatus?.status, reason: json.playabilityStatus?.reason };
      const tracklist = json.captions?.playerCaptionsTracklistRenderer;
      let responseBody = body;
      if (manualFirst && tracklist?.captionTracks) {
        // The library takes the first track when no language is requested; put manual
        // tracks (no kind=asr) first, keeping YouTube's order otherwise.
        tracklist.captionTracks = [
          ...tracklist.captionTracks.filter((t) => t.kind !== "asr"),
          ...tracklist.captionTracks.filter((t) => t.kind === "asr"),
        ];
        responseBody = JSON.stringify(json);
      }
      ctx.captionTracks = (tracklist?.captionTracks ?? []).map((t) => ({
        languageCode: t.languageCode ?? "",
        kind: t.kind,
        name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text ?? "").join(""),
      }));
      return new Response(responseBody, { status: res.status, headers: { "content-type": "application/json" } });
    },
    transcriptFetch: async (p) => {
      const res = await transcriptHookFetch(p);
      const body = await readTextLimited(res, config.transcriptMaxBytes, "Caption track");
      ctx.captionBodyBytes = Buffer.byteLength(body);
      return new Response(body, { status: res.status });
    },
  };
}

/** Same request the library's default fetch makes, routed through contextFetch. Non-OK statuses throw. */
async function transcriptHookFetch(p: FetchParams): Promise<Response> {
  const res = await contextFetch(p.url, {
    method: p.method ?? "GET",
    headers: {
      ...(p.userAgent && { "User-Agent": p.userAgent }),
      ...(p.lang && { "Accept-Language": p.lang }),
      ...p.headers,
    },
    body: p.method === "POST" ? p.body : undefined,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw errorFromHttpStatus(res.status, p.url);
  }
  return res;
}

function classifyTranscriptError(err: unknown, videoId: string, ctx: CallContext): YouTubeError {
  if (ctx.signal.aborted) return ctx.signal.reason;
  if (err instanceof YouTubeError) return err;
  if (!(err instanceof Error)) {
    return new YouTubeError("UPSTREAM_ERROR", `Transcript request failed: ${String(err)}`);
  }
  const libErr = err as TranscriptLibraryError;

  if (libErr.name === "YoutubeTranscriptNotAvailableLanguageError") {
    return new YouTubeError("LANGUAGE_UNAVAILABLE", `No captions in language "${libErr.lang}" for video ${videoId}`, {
      availableLanguages: [...new Set(libErr.availableLangs ?? [])],
    });
  }
  if (libErr.name === "YoutubeTranscriptTooManyRequestError") {
    return new YouTubeError("ACCESS_BLOCKED", "YouTube rate-limited the transcript request", { accessKind: "rate_limited" });
  }
  if (libErr.name === "YoutubeTranscriptInvalidLangError" || libErr.name === "YoutubeTranscriptInvalidVideoIdError") {
    return new YouTubeError("INVALID_INPUT", err.message);
  }
  const disabled = libErr.name === "YoutubeTranscriptDisabledError";
  if (disabled || libErr.name === "YoutubeTranscriptNotAvailableError") {
    const playabilityError = errorFromPlayability(ctx.playability, videoId);
    if (playabilityError) return playabilityError;
    if (!ctx.playability) {
      return new YouTubeError("UPSTREAM_ERROR", `Transcript lookup failed before a player response was received: ${err.message}`);
    }
    if (disabled) {
      return new YouTubeError("CAPTIONS_UNAVAILABLE", `Video ${videoId} is playable but has no caption tracks`, {
        playabilityStatus: ctx.playability.status,
      });
    }
    if (ctx.captionBodyBytes === 0) {
      return new YouTubeError("UPSTREAM_ERROR", "Caption track download returned an empty body (HTTP 200)");
    }
    if (ctx.captionBodyBytes !== undefined) {
      return new YouTubeError("PARSE_ERROR", `No caption segments could be parsed from the caption track (${ctx.captionBodyBytes} bytes)`);
    }
    return new YouTubeError("PARSE_ERROR", `Caption track could not be used: ${err.message}`);
  }
  return new YouTubeError("UPSTREAM_ERROR", `Transcript request failed: ${err.message}`);
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Convert duration in seconds to human-readable format */
function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const h = hours > 0 ? `${hours}h ` : "";
  const m = minutes > 0 ? `${minutes}m ` : "";
  const s = secs > 0 ? `${secs}s` : "";

  return `${h}${m}${s}`.trim() || "0s";
}
