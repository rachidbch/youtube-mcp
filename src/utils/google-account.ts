import { runWithDeadline } from "./abort.js";
import { config } from "./config.js";
import { YouTubeError } from "./errors.js";
import { logger } from "./logger.js";
import { TTLCache } from "./ttl-cache.js";

/**
 * Account-scoped playlist access via Google's official YouTube Data API v3,
 * using an OAuth refresh token (see scripts/google-oauth-login.mjs).
 * Active only when config.accountAuth is set (authenticated install mode);
 * anonymous installs never register these tools.
 *
 * Known API gap: Google does not expose the Watch Later (WL) playlist to any
 * API client, so it is absent by design.
 */

const API = "https://www.googleapis.com/youtube/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// --- Access token management (refresh tokens are long-lived; access tokens ~1h) ---

let accessToken: { token: string; expiresAt: number } | null = null;
let refreshing: Promise<string> | null = null;

function invalidateToken(): void {
  accessToken = null;
}

async function getAccessToken(): Promise<string> {
  const auth = config.accountAuth!;
  if (accessToken && Date.now() < accessToken.expiresAt) return accessToken.token;

  if (!refreshing) {
    refreshing = (async () => {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: auth.clientId,
          client_secret: auth.clientSecret,
          refresh_token: auth.refreshToken,
          grant_type: "refresh_token",
        }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        const revoked = /invalid_grant/.test(body);
        throw new YouTubeError(
          "ACCESS_BLOCKED",
          revoked
            ? "Google rejected the stored refresh token (revoked or expired). Re-run scripts/google-oauth-login.mjs and update YT_GOOGLE_REFRESH_TOKEN."
            : `Google token refresh failed (HTTP ${res.status}).`,
          { httpStatus: res.status, reason: body },
        );
      }
      const json = (await res.json()) as { access_token?: string; expires_in?: number };
      if (typeof json.access_token !== "string") {
        throw new YouTubeError("UPSTREAM_ERROR", "Google token response contained no access_token");
      }
      // Refresh a minute early to avoid handing out tokens that die mid-request.
      const ttlMs = (typeof json.expires_in === "number" ? json.expires_in : 3600) * 1000;
      accessToken = { token: json.access_token, expiresAt: Date.now() + Math.max(ttlMs - 60_000, 30_000) };
      return accessToken.token;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** Google often answers errors with {error: {code, message}}; classify into the shared taxonomy. */
async function apiError(res: Response, what: string): Promise<YouTubeError> {
  let reason = "";
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    reason = body.error?.message ?? body.error?.errors?.[0]?.reason ?? "";
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 401 || res.status === 403) {
    return new YouTubeError("ACCESS_BLOCKED", `Google refused ${what} (HTTP ${res.status}${reason ? `: ${reason}` : ""}).`, {
      httpStatus: res.status,
      reason,
    });
  }
  if (res.status === 404) {
    return new YouTubeError("PLAYLIST_UNAVAILABLE", `${what} not found (HTTP 404${reason ? `: ${reason}` : ""}).`);
  }
  return new YouTubeError("UPSTREAM_ERROR", `Google API request failed: ${what} (HTTP ${res.status}${reason ? `: ${reason}` : ""}).`, {
    httpStatus: res.status,
    reason,
  });
}

/** GET a YouTube Data API endpoint with token auth; retry once on stale-token 401. */
async function apiGet<T>(path: string, params: Record<string, string>, signal: AbortSignal | undefined): Promise<T> {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401 && attempt === 0) {
      invalidateToken(); // stored token expired mid-flight; refresh and retry once
      continue;
    }
    throw await apiError(res, path);
  }
}

// --- Public fetchers ---

export interface MyPlaylist {
  playlistId: string;
  title: string;
  videoCount: number | null;
  privacyStatus: string | null;
  url: string;
  /** created = one of your playlists; liked = your Liked videos; uploads = your channel uploads. */
  kind: "created" | "liked" | "uploads";
}

export interface MyPlaylistsPage {
  playlists: MyPlaylist[];
  page: number;
  hasMore: boolean;
  totalFetched: number;
}

export interface MyPlaylistVideo {
  videoId: string;
  title: string;
  url: string;
  position: number;
  channelName: string | null;
  addedAt: string | null;
}

export interface MyPlaylistVideosPage {
  playlistId: string;
  title: string | null;
  totalVideos: number | null;
  videos: MyPlaylistVideo[];
  page: number;
  hasMore: boolean;
  totalFetched: number;
}

const myPlaylistsCache = new TTLCache<MyPlaylistsPage>(100);
const myPlaylistVideosCache = new TTLCache<MyPlaylistVideosPage>(200);
const CACHE_TTL = {
  myPlaylists: 5 * 60 * 1000,
  myPlaylistVideos: 5 * 60 * 1000,
};

/** YouTube Data API page size; 50 is the maximum for both endpoints we use. */
const API_PAGE = 50;

interface PlaylistListResponse {
  items?: Array<{
    id: string;
    snippet?: { title?: string };
    status?: { privacyStatus?: string };
    contentDetails?: { itemCount?: number };
  }>;
  nextPageToken?: string;
}

interface PlaylistItemsResponse {
  items?: Array<{
    snippet?: {
      title?: string;
      position?: number;
      publishedAt?: string;
      videoOwnerChannelTitle?: string;
      resourceId?: { videoId?: string };
    };
  }>;
  nextPageToken?: string;
}

interface ChannelsResponse {
  items?: Array<{ contentDetails?: { relatedPlaylists?: { likes?: string; uploads?: string } } }>;
}

/**
 * Your playlists: everything playlists.list(mine=true) returns (created playlists,
 * any privacy), plus the Liked and Uploads pseudo-playlists from channels.list.
 * Watch Later is not exposed by the API at all.
 */
export function fetchMyPlaylists(page: number = 1, signal?: AbortSignal): Promise<MyPlaylistsPage> {
  const cacheKey = `mine|${page}`;
  const cached = myPlaylistsCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  return runWithDeadline(signal, config.requestTimeoutMs, "list_my_playlists", async (s) => {
    let current: PlaylistListResponse | undefined;
    let nextToken: string | undefined;
    for (let i = 0; i < page; i++) {
      const params: Record<string, string> = { part: "snippet,status,contentDetails", mine: "true", maxResults: "50" };
      if (nextToken) params.pageToken = nextToken;
      current = await apiGet<PlaylistListResponse>("playlists", params, s);
      nextToken = current.nextPageToken;
      if (!nextToken && i + 1 < page) break; // requested page past the end
    }
    const created: MyPlaylist[] = (current?.items ?? []).map((item) => ({
      playlistId: item.id,
      title: item.snippet?.title ?? "(untitled)",
      videoCount: typeof item.contentDetails?.itemCount === "number" ? item.contentDetails.itemCount : null,
      privacyStatus: item.status?.privacyStatus ?? null,
      url: `https://www.youtube.com/playlist?list=${item.id}`,
      kind: "created" as const,
    }));

    const special: MyPlaylist[] = [];
    if (page === 1) {
      try {
        const channel = await apiGet<ChannelsResponse>("channels", { part: "contentDetails", mine: "true" }, s);
        const related = channel.items?.[0]?.contentDetails?.relatedPlaylists;
        if (related?.likes) {
          special.push({
            playlistId: related.likes,
            title: "Liked videos",
            videoCount: null,
            privacyStatus: "private",
            url: "https://www.youtube.com/playlist?list=LL",
            kind: "liked",
          });
        }
        if (related?.uploads) {
          special.push({
            playlistId: related.uploads,
            title: "My uploads",
            videoCount: null,
            privacyStatus: "public",
            url: `https://www.youtube.com/playlist?list=${related.uploads}`,
            kind: "uploads",
          });
        }
      } catch (err) {
        // Liked/Uploads are a bonus; never fail the whole listing for them.
        logger.warn("Could not fetch channel related playlists", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const result: MyPlaylistsPage = {
      playlists: [...special, ...created],
      page,
      hasMore: !!nextToken,
      totalFetched: created.length,
    };
    myPlaylistsCache.set(cacheKey, result, CACHE_TTL.myPlaylists);
    return result;
  });
}

/** Videos of one of your playlists (works for Liked LL and Uploads UU ids too). */
export function fetchMyPlaylistVideos(
  playlistId: string,
  maxResults: number = 25,
  page: number = 1,
  signal?: AbortSignal,
): Promise<MyPlaylistVideosPage> {
  const cacheKey = `${playlistId}|${maxResults}|${page}`;
  const cached = myPlaylistVideosCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  return runWithDeadline(signal, config.requestTimeoutMs, "get_my_playlist_videos", async (s) => {
    // Walk API pages (50/video-page) until we have one item more than needed,
    // so hasMore is exact — same convention as the anonymous playlist tool.
    const need = page * maxResults + 1;
    const collected: MyPlaylistVideo[] = [];
    let nextToken: string | undefined;
    let first: PlaylistItemsResponse | undefined;
    for (;;) {
      const params: Record<string, string> = { part: "snippet", playlistId, maxResults: "50" };
      if (nextToken) params.pageToken = nextToken;
      const res = (first = await apiGet<PlaylistItemsResponse>("playlistItems", params, s));
      for (const item of res.items ?? []) {
        const videoId = item.snippet?.resourceId?.videoId;
        if (!videoId || item.snippet?.title === "Private video" || item.snippet?.title === "Deleted video") continue;
        collected.push({
          videoId,
          title: item.snippet?.title ?? "(untitled)",
          url: `https://www.youtube.com/watch?v=${videoId}`,
          position: typeof item.snippet?.position === "number" ? item.snippet.position : collected.length,
          channelName: item.snippet?.videoOwnerChannelTitle ?? null,
          addedAt: item.snippet?.publishedAt ?? null,
        });
      }
      nextToken = res.nextPageToken;
      if (collected.length >= need || !nextToken) break;
    }

    const slice = collected.slice((page - 1) * maxResults, page * maxResults);
    const result: MyPlaylistVideosPage = {
      playlistId,
      title: null, // playlistItems does not carry playlist metadata; list_my_playlists has it
      totalVideos: null,
      videos: slice,
      page,
      hasMore: collected.length > page * maxResults,
      totalFetched: slice.length,
    };
    myPlaylistVideosCache.set(cacheKey, result, CACHE_TTL.myPlaylistVideos);
    return result;
  });
}

/** Test hook. */
export function resetAccountForTesting(): void {
  invalidateToken();
  myPlaylistsCache.clear();
  myPlaylistVideosCache.clear();
}

export const ACCOUNT_API_PAGE = API_PAGE;
