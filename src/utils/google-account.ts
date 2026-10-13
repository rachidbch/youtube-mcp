import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runWithDeadline } from "./abort.js";
import { config } from "./config.js";
import { YouTubeError } from "./errors.js";
import { logger } from "./logger.js";
import { TTLCache } from "./ttl-cache.js";

/**
 * Account-scoped access via Google's official YouTube Data API v3.
 *
 * Auth is a runtime state machine, surfaced to agents through four tools
 * (get_auth_status / start_auth / complete_auth / reset_auth) so an agent can
 * guide its human or drive a browser itself:
 *
 *   not_configured -> not_authenticated -> consent_pending -> authenticated
 *                                              |                  |
 *                                              v                  v (token revoked)
 *                                          (expire)              expired -> start_auth (roll)
 *
 * Token sources: a state file written by complete_auth (preferred) or an
 * install-time YT_GOOGLE_REFRESH_TOKEN (rolls require env change + restart).
 *
 * Known API gap: Google does not expose the Watch Later (WL) playlist to any
 * API client, so it is absent by design.
 */

const API = "https://www.googleapis.com/youtube/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
/** Desktop-app OAuth clients allow any loopback port; fixed for clarity. */
const REDIRECT_URI = "http://localhost:8479";
const CONSENT_TTL_MS = 15 * 60 * 1000;

// --- Auth state ---

export type AuthState =
  | "not_configured"   // no OAuth client in env: anonymous install
  | "not_authenticated" // client ready, no token yet
  | "consent_pending"  // start_auth issued a consent URL, waiting for complete_auth
  | "authenticated"    // a working refresh token exists
  | "expired";         // refresh token revoked/expired

export interface AuthStatus {
  state: AuthState;
  /** Where the refresh token came from, when one exists. */
  tokenSource: "file" | "env" | null;
  /** Channel title/id of the consenting account, when known. */
  account: { title: string | null; channelId: string | null } | null;
  /** Machine-readable next step for an agent. */
  nextAction:
    | "install_client_credentials"
    | "start_auth"
    | "complete_auth"
    | "none"
    | "start_auth"; // expired -> roll
  /** Human/agent-readable instructions for the next step. */
  instructions: string;
  /** Present while state is consent_pending. */
  consentUrl?: string;
  consentExpiresAt?: number;
}

interface StoredAuth {
  refreshToken: string;
  obtainedAt: string;
  accountTitle: string | null;
  accountId: string | null;
}

function stateFilePath(): string {
  return resolve(process.env.YT_AUTH_STATE_FILE ?? join(process.cwd(), ".youtube-mcp-auth.json"));
}

function readStoredAuth(): StoredAuth | null {
  try {
    const raw = readFileSync(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as StoredAuth;
    return typeof parsed.refreshToken === "string" && parsed.refreshToken.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredAuth(stored: StoredAuth): void {
  const path = stateFilePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path); // atomic on same filesystem
}

function deleteStoredAuth(): void {
  try {
    unlinkSync(stateFilePath());
  } catch {
    /* already gone */
  }
}

/** In-flight consent (nonce -> URL), memory-only: a restart simply restarts the flow. */
let pendingConsent: { nonce: string; url: string; startedAt: number } | null = null;

function currentRefreshToken(): { token: string; source: "file" | "env" } | null {
  const stored = readStoredAuth();
  if (stored) return { token: stored.refreshToken, source: "file" };
  if (config.googleClient && config.googleRefreshTokenEnv) return { token: config.googleRefreshTokenEnv, source: "env" };
  return null;
}

// --- Access token management ---

let accessToken: { token: string; expiresAt: number } | null = null;
let refreshing: Promise<string> | null = null;

function invalidateAccessToken(): void {
  accessToken = null;
}

class TokenRejectedError extends YouTubeError {
  constructor(message: string) {
    super("ACCESS_BLOCKED", message);
  }
}

async function refreshAccessToken(refreshToken: string, source: "file" | "env"): Promise<string> {
  const client = config.googleClient;
  if (!client) throw new YouTubeError("UPSTREAM_ERROR", "OAuth client not configured");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (res.ok) {
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (typeof json.access_token !== "string") {
      throw new YouTubeError("UPSTREAM_ERROR", "Google token response contained no access_token");
    }
    const ttlMs = (typeof json.expires_in === "number" ? json.expires_in : 3600) * 1000;
    accessToken = { token: json.access_token, expiresAt: Date.now() + Math.max(ttlMs - 60_000, 30_000) };
    return accessToken.token;
  }
  const body = (await res.text()).slice(0, 300);
  if (/invalid_grant/.test(body)) {
    throw new TokenRejectedError(
      source === "file"
        ? "Refresh token rejected (revoked or expired). Call get_auth_status, then start_auth to roll a new one."
        : "Env-provided refresh token rejected (revoked or expired). Re-run scripts/google-oauth-login.mjs, update YT_GOOGLE_REFRESH_TOKEN, and restart the server.",
    );
  }
  throw new YouTubeError("UPSTREAM_ERROR", `Google token refresh failed (HTTP ${res.status}).`, { httpStatus: res.status, reason: body });
}

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessToken.expiresAt) return accessToken.token;
  const current = currentRefreshToken();
  if (!current) {
    throw new YouTubeError(
      "ACCESS_BLOCKED",
      "Not authenticated. Call get_auth_status for the current auth state and next step.",
    );
  }
  if (!refreshing) {
    refreshing = refreshAccessToken(current.token, current.source)
      .catch((err) => {
        if (err instanceof TokenRejectedError) invalidateAccessToken();
        throw err;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

// --- State machine operations (the auth tools) ---

export function getAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
  return runWithDeadline(signal, config.requestTimeoutMs, "get_auth_status", async () => {
    if (!config.googleClient) {
      return {
        state: "not_configured",
        tokenSource: null,
        account: null,
        nextAction: "install_client_credentials",
        instructions:
          "Anonymous install: no Google OAuth client configured, so account tools (my playlists) are unavailable. " +
          "To enable them: create a Google Cloud project with YouTube Data API v3 enabled and an OAuth client of type Desktop app, " +
          "set YT_GOOGLE_CLIENT_ID and YT_GOOGLE_CLIENT_SECRET, restart, then call get_auth_status again. See the README section " +
          '"Fork: anonymous vs authenticated mode".',
      } satisfies AuthStatus;
    }

    const current = currentRefreshToken();

    if (pendingConsent && Date.now() - pendingConsent.startedAt < CONSENT_TTL_MS) {
      return {
        state: "consent_pending",
        tokenSource: current?.source ?? null,
        account: storedAccount(),
        nextAction: "complete_auth",
        instructions:
          "Consent URL already issued. Send the account owner to consentUrl (or open it in a browser you control), " +
          "let them click Allow; the browser then lands on a localhost error page - that is expected. " +
          "Copy that page's full address (it contains the code) and pass it to complete_auth. " +
          "If the URL expired, call start_auth again.",
        consentUrl: pendingConsent.url,
        consentExpiresAt: pendingConsent.startedAt + CONSENT_TTL_MS,
      } satisfies AuthStatus;
    }

    if (!current) {
      return {
        state: "not_authenticated",
        tokenSource: null,
        account: null,
        nextAction: "start_auth",
        instructions:
          "OAuth client configured but no refresh token yet. Call start_auth; it returns a consentUrl. " +
          "The account owner approves it in a browser (or you drive the browser yourself); afterwards pass the resulting " +
          "localhost redirect URL to complete_auth.",
      } satisfies AuthStatus;
    }

    // A token exists: status is authoritative - always re-verify against Google
    // (a cached access token could mask a revoked refresh token for up to ~1h).
    invalidateAccessToken();
    let healthy = true;
    let rejection: TokenRejectedError | null = null;
    {
      try {
        await refreshAccessToken(current.token, current.source);
      } catch (err) {
        if (err instanceof TokenRejectedError) {
          healthy = false;
          rejection = err;
        } else {
          throw err; // transient Google problem, not an auth-state verdict
        }
      }
    }

    if (!healthy) {
      return {
        state: "expired",
        tokenSource: current.source,
        account: storedAccount(),
        nextAction: "start_auth",
        instructions:
          rejection?.message ??
          "Refresh token no longer works. Call start_auth to roll a new one (the old one is replaced on complete_auth).",
      } satisfies AuthStatus;
    }

    return {
      state: "authenticated",
      tokenSource: current.source,
      account: storedAccount(),
      nextAction: "none",
      instructions:
        current.source === "env"
          ? "Authenticated via install-time token (env). Account tools are available. To roll the token, re-run scripts/google-oauth-login.mjs and update YT_GOOGLE_REFRESH_TOKEN, then restart."
          : "Authenticated. Account tools (list_my_playlists, get_my_playlist_videos) are available. Watch Later is never available: Google's API does not expose it.",
    } satisfies AuthStatus;
  });
}

function storedAccount(): AuthStatus["account"] {
  const stored = readStoredAuth();
  if (stored) return { title: stored.accountTitle, channelId: stored.accountId };
  return null;
}

export function startAuth(signal?: AbortSignal): Promise<AuthStatus & { consentUrl: string }> {
  return runWithDeadline(signal, config.requestTimeoutMs, "start_auth", async () => {
    const client = config.googleClient;
    if (!client) {
      throw new YouTubeError("INVALID_INPUT", "No OAuth client configured. See get_auth_status for how to install one.");
    }
    if (pendingConsent && Date.now() - pendingConsent.startedAt < CONSENT_TTL_MS) {
      return consentStatus();
    }
    const nonce = randomUUID();
    const url =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
        state: nonce,
      });
    pendingConsent = { nonce, url, startedAt: Date.now() };
    return consentStatus();
  });
}

function consentStatus(): AuthStatus & { consentUrl: string } {
  if (!pendingConsent) throw new YouTubeError("UPSTREAM_ERROR", "Consent session lost; call start_auth again.");
  return {
    state: "consent_pending",
    tokenSource: currentRefreshToken()?.source ?? null,
    account: storedAccount(),
    nextAction: "complete_auth",
    instructions:
      "Send the account owner to consentUrl (or open it in a browser you control) and let them click Allow. " +
      "The browser then shows a localhost error page - expected: nothing listens there. " +
      "Its full address contains ?code=...&state=...; pass that whole URL (or just the code) to complete_auth. " +
      `The consent session expires ${new Date(pendingConsent.startedAt + CONSENT_TTL_MS).toISOString()}.`,
    consentUrl: pendingConsent.url,
    consentExpiresAt: pendingConsent.startedAt + CONSENT_TTL_MS,
  };
}

export function completeAuth(redirectUrlOrCode: string, signal?: AbortSignal): Promise<AuthStatus> {
  return runWithDeadline(signal, config.requestTimeoutMs, "complete_auth", async () => {
    const client = config.googleClient;
    if (!client) throw new YouTubeError("INVALID_INPUT", "No OAuth client configured. See get_auth_status.");
    if (!pendingConsent || Date.now() - pendingConsent.startedAt >= CONSENT_TTL_MS) {
      throw new YouTubeError("INVALID_INPUT", "No active consent session (they expire after 15 minutes). Call start_auth first.");
    }

    let code: string | null = null;
    let state: string | null = null;
    const trimmed = redirectUrlOrCode.trim();
    if (trimmed.includes("://")) {
      try {
        const url = new URL(trimmed);
        code = url.searchParams.get("code");
        state = url.searchParams.get("state");
      } catch {
        code = null;
      }
    } else if (/^4\/[\w-]+$/.test(trimmed) || trimmed.length > 50) {
      code = trimmed; // a bare code pasted by hand
    }
    if (!code) {
      throw new YouTubeError("INVALID_INPUT", "Could not find ?code= in the provided URL. Pass the full localhost redirect address.");
    }
    if (state !== null && state !== pendingConsent.nonce) {
      throw new YouTubeError("INVALID_INPUT", "The state parameter does not match this server's consent session (possible mix-up with another login). Call start_auth for a fresh URL.");
    }

    const exchange = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokens = (await exchange.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string };
    if (!exchange.ok || typeof tokens.refresh_token !== "string") {
      throw new YouTubeError("ACCESS_BLOCKED", `Google rejected the consent code (HTTP ${exchange.status}). Call start_auth and consent again.`);
    }

    // Identify the account (best-effort; a title is nicer in every status output).
    let accountTitle: string | null = null;
    let accountId: string | null = null;
    if (typeof tokens.access_token === "string") {
      try {
        const ch = await fetch(`${API}/channels?part=snippet&mine=true`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (ch.ok) {
          const json = (await ch.json()) as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
          accountTitle = json.items?.[0]?.snippet?.title ?? null;
          accountId = json.items?.[0]?.id ?? null;
        }
      } catch {
        /* identification is cosmetic */
      }
    }

    writeStoredAuth({
      refreshToken: tokens.refresh_token,
      obtainedAt: new Date().toISOString(),
      accountTitle,
      accountId,
    });
    invalidateAccessToken();
    pendingConsent = null;
    logger.info("Google account token stored", { accountTitle });

    return {
      state: "authenticated",
      tokenSource: "file",
      account: { title: accountTitle, channelId: accountId },
      nextAction: "none",
      instructions: `Authenticated${accountTitle ? ` as "${accountTitle}"` : ""}. Account tools (list_my_playlists, get_my_playlist_videos) are now available. Watch Later is never available: Google's API does not expose it.`,
    } satisfies AuthStatus;
  });
}

export function resetAuth(revoke: boolean, signal?: AbortSignal): Promise<AuthStatus> {
  return runWithDeadline(signal, config.requestTimeoutMs, "reset_auth", async () => {
    const current = currentRefreshToken();
    if (revoke && current && config.googleClient) {
      try {
        await fetch(REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: current.token }),
        });
      } catch {
        /* revocation is best-effort; the local token is dropped regardless */
      }
    }
    deleteStoredAuth();
    invalidateAccessToken();
    pendingConsent = null;
    const status: AuthStatus = config.googleClient
      ? {
          state: "not_authenticated",
          tokenSource: null,
          account: null,
          nextAction: "start_auth",
          instructions:
            "Local credentials cleared" +
            (revoke ? " and the refresh token revoked at Google" : "") +
            ". Call start_auth to authenticate again.",
        }
      : {
          state: "not_configured",
          tokenSource: null,
          account: null,
          nextAction: "install_client_credentials",
          instructions: "Local credentials cleared. No OAuth client is configured; see get_auth_status for how to enable account access.",
        };
    return status;
  });
}

// --- Data API plumbing (account tools) ---

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

async function apiGet<T>(path: string, params: Record<string, string>, signal: AbortSignal | undefined): Promise<T> {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401 && attempt === 0) {
      invalidateAccessToken();
      continue;
    }
    throw await apiError(res, path);
  }
}

export interface MyPlaylist {
  playlistId: string;
  title: string;
  videoCount: number | null;
  privacyStatus: string | null;
  url: string;
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
  title: null;
  totalVideos: null;
  videos: MyPlaylistVideo[];
  page: number;
  hasMore: boolean;
  totalFetched: number;
}

const myPlaylistsCache = new TTLCache<MyPlaylistsPage>(100);
const myPlaylistVideosCache = new TTLCache<MyPlaylistVideosPage>(200);
const CACHE_TTL = { myPlaylists: 5 * 60 * 1000, myPlaylistVideos: 5 * 60 * 1000 };

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
      if (!nextToken && i + 1 < page) break;
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
        logger.warn("Could not fetch channel related playlists", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const result: MyPlaylistsPage = { playlists: [...special, ...created], page, hasMore: !!nextToken, totalFetched: created.length };
    myPlaylistsCache.set(cacheKey, result, CACHE_TTL.myPlaylists);
    return result;
  });
}

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
    const need = page * maxResults + 1;
    const collected: MyPlaylistVideo[] = [];
    let nextToken: string | undefined;
    for (;;) {
      const params: Record<string, string> = { part: "snippet", playlistId, maxResults: "50" };
      if (nextToken) params.pageToken = nextToken;
      const res = await apiGet<PlaylistItemsResponse>("playlistItems", params, s);
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
      title: null,
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

/** Test hook: drop caches, pending consent and (optionally) the stored token. */
export function resetAccountForTesting(options: { dropToken?: boolean } = {}): void {
  invalidateAccessToken();
  pendingConsent = null;
  myPlaylistsCache.clear();
  myPlaylistVideosCache.clear();
  if (options.dropToken) deleteStoredAuth();
}

export const AUTH_CONSTANTS = { REDIRECT_URI, SCOPE, CONSENT_TTL_MS, stateFilePath };
