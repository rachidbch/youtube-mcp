import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runWithDeadline } from "./abort.js";
import { config } from "./config.js";
import { YouTubeError } from "./errors.js";
import { logger } from "./logger.js";

/**
 * Personalized home feed and notifications through an authenticated
 * InnerTube session (youtubei.js device-code login, like a smart TV).
 *
 * NO official Google API exists for these (Data API v3 has no home feed /
 * notifications), so this rides the fragile surface deliberately. Robustness
 * rules for this module: never crash, degrade to empty lists with notes on
 * shape surprises, and surface auth state explicitly (start_feed_auth +
 * get_auth_status.feedAuth).
 */

export type FeedAuthState = "signed_out" | "sign_in_pending" | "signed_in";

interface FeedSession {
  innertube: any; // youtubei.js Innertube instance for the account session
}

let session: FeedSession | null = null;
let sessionPromise: Promise<FeedSession> | null = null;
let pendingCode: { verificationUrl: string; userCode: string; expiresAt: number } | null = null;

function cacheDir(): string {
  const base = resolve(process.env.YT_AUTH_STATE_FILE ?? join(process.cwd(), ".youtube-mcp-auth.json"));
  const dir = join(dirname(base), "innertube-cache");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Lazy singleton: a separate Innertube instance with a persistent token cache. */
async function getFeedSession(signal?: AbortSignal): Promise<FeedSession> {
  if (session?.innertube.session?.oauth?.oauth2_tokens) return session;
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const { Innertube, UniversalCache } = await import("youtubei.js");
      const innertube = await Innertube.create({
        cache: new UniversalCache(true, cacheDir()),
        retrieve_player: false, // feed/notifications never need stream deciphering
        ...(signal ? {} : {}),
      });
      const s: FeedSession = { innertube };
      session = s;
      return s;
    })().catch((err) => {
      sessionPromise = null; // allow retry on next call
      throw new YouTubeError("UPSTREAM_ERROR", `InnerTube session creation failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return sessionPromise;
}

function feedTokens(s: FeedSession | null): unknown {
  try {
    return s?.innertube?.session?.oauth?.oauth2_tokens ?? null;
  } catch {
    return null;
  }
}

export function getFeedAuthState(): { state: FeedAuthState; pending?: { verificationUrl: string; userCode: string } } {
  if (pendingCode && Date.now() < pendingCode.expiresAt) {
    return { state: "sign_in_pending", pending: { verificationUrl: pendingCode.verificationUrl, userCode: pendingCode.userCode } };
  }
  pendingCode = null;
  return { state: feedTokens(session) ? "signed_in" : "signed_out" };
}

/** Begin the device-code login (smart-TV style): returns the URL + code a human enters once. */
export async function startFeedAuth(signal?: AbortSignal): Promise<{ verificationUrl: string; userCode: string; expiresInMinutes: number }> {
  return runWithDeadline(signal, config.requestTimeoutMs, "start_feed_auth", async () => {
    if (getFeedAuthState().state === "signed_in") {
      throw new YouTubeError("INVALID_INPUT", "Already signed in. To switch accounts, call reset_auth first.");
    }
    const s = await getFeedSession();
    const oauth = s.innertube.session.oauth;
    const code = await oauth.getDeviceAndUserCode();
    pendingCode = {
      verificationUrl: code.verification_url,
      userCode: code.user_code,
      expiresAt: Date.now() + (code.expires_in ?? 1800) * 1000,
    };
    // Background: poll until the user finishes; persist tokens on success.
    oauth
      .pollForAccessToken(code)
      .then(() => oauth.cacheCredentials())
      .then(() => {
        pendingCode = null;
        logger.info("InnerTube session established (home feed/notifications)");
      })
      .catch((err: unknown) => {
        pendingCode = null;
        logger.warn("InnerTube sign-in failed", { error: err instanceof Error ? err.message : String(err) });
      });
    return { verificationUrl: code.verification_url, userCode: code.user_code, expiresInMinutes: Math.round((code.expires_in ?? 1800) / 60) };
  });
}

function requireSignedIn(): FeedSession {
  const s = session;
  if (!feedTokens(s)) {
    throw new YouTubeError(
      "ACCESS_BLOCKED",
      "Home feed and notifications need a one-time YouTube sign-in on this server. Call start_feed_auth, have the account owner open the verification URL and enter the code, then retry. Check get_auth_status.feedAuth for progress.",
    );
  }
  return s!;
}

function requireTokensFresh(s: FeedSession): void {
  const oauth = s.innertube.session.oauth;
  try {
    if (oauth.shouldRefreshToken?.()) {
      oauth.refreshAccessToken(); // fire-and-forget; next signed call re-checks
    }
  } catch {
    /* refreshed lazily by the library */
  }
}

export interface FeedVideo {
  videoId: string;
  title: string;
  url: string;
  channelName: string | null;
}

/** Personalized home-page recommendations. Degrades to whatever is parseable - never throws on shape. */
export async function fetchMyFeed(maxResults: number, signal?: AbortSignal): Promise<{ videos: FeedVideo[]; note: string | null }> {
  return runWithDeadline(signal, config.requestTimeoutMs, "get_my_feed", async () => {
    const s = requireSignedIn();
    requireTokensFresh(s);
    const feed = await s.innertube.getHomeFeed();

    const raw: unknown[] = [];
    try {
      const videos = feed.videos;
      if (Array.isArray(videos)) raw.push(...videos);
    } catch {
      /* no videos getter */
    }
    if (raw.length === 0) {
      try {
        raw.push(...(feed.page?.contents_memo?.getType("Video") ?? []));
        raw.push(...(feed.page?.contents_memo?.getType("GridVideo") ?? []));
      } catch {
        /* structural fallback failed too */
      }
    }

    const out: FeedVideo[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const rec = item as Record<string, unknown>;
      let id = typeof rec["id"] === "string" ? rec["id"] : undefined;
      if (!id) {
        const ep = rec["endpoint"] as Record<string, Record<string, unknown>> | undefined;
        const pid = (ep?.["payload"]?.["videoId"] ?? rec["content_id"]) as string | undefined;
        id = typeof pid === "string" ? pid : undefined;
      }
      const title = (() => {
        try {
          const t = rec["title"];
          return typeof t === "string" ? t : t?.toString?.() || "";
        } catch {
          return "";
        }
      })();
      if (!id || !title || seen.has(id)) continue;
      const author = (() => {
        try {
          const a = rec["author"];
          if (typeof a === "string") return a;
          const name = (a as Record<string, unknown> | undefined)?.["name"];
          return typeof name === "string" ? name : null;
        } catch {
          return null;
        }
      })();
      seen.add(id);
      out.push({ videoId: id, title, url: `https://www.youtube.com/watch?v=${id}`, channelName: author });
      if (out.length >= maxResults) break;
    }
    return {
      videos: out,
      note: out.length === 0 ? "Signed in, but the home feed returned no recognizable videos (YouTube may be serving an empty or changed layout). Retry later; this is not an auth problem." : null,
    };
  });
}

export interface FeedNotification {
  title: string;
  sentText: string | null;
  read: boolean | null;
  videoUrl: string | null;
  channelName: string | null;
}

/** Bell notifications. Degrades to an empty list on shape surprises - never throws on shape. */
export async function fetchMyNotifications(signal?: AbortSignal): Promise<{ notifications: FeedNotification[]; note: string | null }> {
  return runWithDeadline(signal, config.requestTimeoutMs, "get_my_notifications", async () => {
    const s = requireSignedIn();
    requireTokensFresh(s);
    const menu = await s.innertube.getNotifications();

    const out: FeedNotification[] = [];
    try {
      const items = Array.isArray(menu.contents) ? menu.contents : [];
      for (const item of items as Array<Record<string, unknown>>) {
        const title = (() => {
          try {
            const t = item["title"];
            return typeof t === "string" ? t : t?.toString?.() || "";
          } catch {
            return "";
          }
        })();
        if (!title) continue;
        let videoUrl: string | null = null;
        try {
          const vid = item["video_id"];
          if (typeof vid === "string") videoUrl = `https://www.youtube.com/watch?v=${vid}`;
        } catch {
          /* no video attached */
        }
        out.push({
          title,
          sentText: typeof item["sent_at"] === "string" ? item["sent_at"] : null,
          read: typeof item["read"] === "boolean" ? item["read"] : null,
          videoUrl,
          channelName: typeof item["channel"] === "string" ? item["channel"] : null,
        });
      }
    } catch {
      /* whole-menu shape surprise: return what we have */
    }
    return {
      notifications: out,
      note: out.length === 0 ? "No notifications right now, or YouTube served an unrecognized layout. This is not an auth problem." : null,
    };
  });
}

/** Drop the InnerTube session (used by reset_auth). Best-effort: never throws. */
export async function clearFeedAuth(): Promise<void> {
  const s = session;
  pendingCode = null;
  session = null;
  sessionPromise = null;
  try {
    const oauth = s?.innertube?.session?.oauth;
    if (oauth?.oauth2_tokens) await oauth.revokeCredentials?.().catch(() => undefined);
    await oauth?.removeCache?.().catch(() => undefined);
  } catch {
    /* best effort */
  }
}

/** Test hook. */
export function resetFeedForTesting(): void {
  pendingCode = null;
  session = null;
  sessionPromise = null;
}
