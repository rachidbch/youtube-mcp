/**
 * Error taxonomy shared by every tool. The goal is to keep upstream evidence
 * (HTTP status, playability status, YouTube's own reason text) instead of
 * collapsing everything into "not found" or "no captions".
 */
export type ErrorCode =
  | "INVALID_INPUT"
  | "ACCESS_BLOCKED"
  | "VIDEO_UNAVAILABLE"
  | "CAPTIONS_UNAVAILABLE"
  | "LANGUAGE_UNAVAILABLE"
  | "COMMENTS_UNAVAILABLE"
  | "PARSE_ERROR"
  | "LIMIT_EXCEEDED"
  | "TIMEOUT"
  | "CANCELLED"
  | "UPSTREAM_ERROR";

export type AccessKind = "rate_limited" | "forbidden" | "login_required" | "consent_required";

export interface UpstreamDetails {
  httpStatus?: number;
  url?: string;
  playabilityStatus?: string;
  reason?: string;
  accessKind?: AccessKind;
  availableLanguages?: string[];
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["TIMEOUT", "UPSTREAM_ERROR"]);

export class YouTubeError extends Error {
  readonly code: ErrorCode;
  readonly upstream: UpstreamDetails;

  constructor(code: ErrorCode, message: string, upstream: UpstreamDetails = {}) {
    super(message);
    this.name = "YouTubeError";
    this.code = code;
    this.upstream = upstream;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: RETRYABLE.has(this.code),
      upstream: this.upstream,
    };
  }
}

export interface PlayabilityStatus {
  status?: string;
  reason?: string;
}

/** Classify an HTTP failure from any YouTube endpoint. */
export function errorFromHttpStatus(status: number, url: string): YouTubeError {
  const where = describeUrl(url);
  if (status === 429) {
    return new YouTubeError("ACCESS_BLOCKED", `YouTube rate-limited the request (HTTP 429 from ${where})`, {
      httpStatus: status, url: where, accessKind: "rate_limited",
    });
  }
  if (status === 403) {
    return new YouTubeError("ACCESS_BLOCKED", `YouTube refused the request (HTTP 403 from ${where})`, {
      httpStatus: status, url: where, accessKind: "forbidden",
    });
  }
  return new YouTubeError("UPSTREAM_ERROR", `YouTube request failed (HTTP ${status} from ${where})`, {
    httpStatus: status, url: where,
  });
}

/**
 * Classify a non-OK playability status from the InnerTube player response.
 * Returns null when the status is OK (or absent), meaning playability is not the cause.
 */
export function errorFromPlayability(p: PlayabilityStatus | undefined, videoId: string): YouTubeError | null {
  const status = p?.status;
  if (!status || status === "OK") return null;
  const reason = p?.reason || undefined;
  const upstream: UpstreamDetails = { playabilityStatus: status, reason };
  const suffix = reason ? `: ${reason}` : "";

  switch (status) {
    case "LOGIN_REQUIRED":
      if (reason && /private/i.test(reason)) {
        return new YouTubeError("VIDEO_UNAVAILABLE", `Video ${videoId} is private${suffix}`, upstream);
      }
      return new YouTubeError("ACCESS_BLOCKED", `YouTube requires sign-in to access video ${videoId}${suffix}`, {
        ...upstream, accessKind: "login_required",
      });
    case "AGE_CHECK_REQUIRED":
    case "AGE_VERIFICATION_REQUIRED":
    case "CONTENT_CHECK_REQUIRED":
      return new YouTubeError("ACCESS_BLOCKED", `YouTube requires a content or age check for video ${videoId}${suffix}`, {
        ...upstream, accessKind: "login_required",
      });
    case "ERROR":
    case "UNPLAYABLE":
    case "LIVE_STREAM_OFFLINE":
      return new YouTubeError("VIDEO_UNAVAILABLE", `YouTube reports video ${videoId} as ${status}${suffix}`, upstream);
    default:
      return new YouTubeError("UPSTREAM_ERROR", `YouTube returned playability status ${status} for video ${videoId}${suffix}`, upstream);
  }
}

export function toYouTubeError(err: unknown): YouTubeError {
  if (err instanceof YouTubeError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new YouTubeError("UPSTREAM_ERROR", msg);
}

/** Key under which error results carry the machine-readable error in `_meta`. */
export const ERROR_META_KEY = "youtube-mcp/error";

/**
 * Standard MCP error result: readable text plus a machine-readable error object.
 * The object goes in `_meta`, not `structuredContent`: MCP SDK clients validate any
 * structuredContent against the tool's outputSchema, even on error results.
 */
export function errorResult(err: unknown) {
  const e = toYouTubeError(err);
  return {
    content: [{ type: "text" as const, text: `❌ [${e.code}] ${e.message}` }],
    _meta: { [ERROR_META_KEY]: e.toJSON() },
    isError: true,
  };
}

/** Host + path only; query strings can carry API keys and signed parameters. */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "unknown URL";
  }
}
