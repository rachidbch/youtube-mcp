import { z } from "zod";
import { errorResult, YouTubeError } from "../utils/errors.js";
import { completeAuth, getAuthStatus, resetAuth, startAuth, type AuthStatus } from "../utils/google-account.js";
import { getFeedAuthState, startFeedAuth, type FeedAuthState } from "../utils/youtube-feed.js";
import { endpointDomainStatus, rollEndpointToken } from "../utils/endpoint-token.js";

/**
 * The single auth tool: a state machine across three security domains.
 *   - endpoint: the HTTP bearer token this server owns (generated at install)
 *   - google:   the Google account (playlists) via official Data API consent
 *   - feed:     personalized home feed / notifications via InnerTube device code
 * Calling it with no arguments returns the full state and per-domain next
 * actions, so an agent always knows what to do - escalate to its human or
 * drive a browser itself. Completing google auth ROLLS the endpoint token
 * instantly (the response carries the new one).
 */

const domainSchema = z.enum(["endpoint", "google", "feed"]).describe("Which auth domain this action applies to");
const actionSchema = z.enum(["status", "start", "complete", "roll", "reset"]).describe("status returns everything; start/complete drive consent flows; roll rotates the endpoint token; reset clears google+feed");

export const authSchema = z.object({
  action: actionSchema.optional().default("status"),
  domain: domainSchema.optional(),
  redirectUrl: z
    .string()
    .min(10)
    .optional()
    .describe("For google complete: the full localhost redirect URL after Allow (contains code and state), or the bare code"),
  confirm: z
    .boolean()
    .optional()
    .default(false)
    .describe("Required true for roll and reset (they cut off other clients / sign out)"),
});

const googleDomain = z.object({
  state: z.enum(["not_configured", "not_authenticated", "consent_pending", "authenticated", "expired"]),
  tokenSource: z.enum(["file", "env"]).nullable(),
  account: z.object({ title: z.string().nullable(), channelId: z.string().nullable() }).nullable(),
  nextAction: z.enum(["install_client_credentials", "start_auth", "complete_auth", "none"]),
  instructions: z.string(),
  consentUrl: z.string().optional(),
  consentExpiresAt: z.number().optional(),
});

const feedDomain = z.object({
  state: z.enum(["signed_out", "sign_in_pending", "signed_in"]),
  nextAction: z.enum(["start_feed_auth", "wait_for_user", "none"]),
  instructions: z.string(),
  verificationUrl: z.string().optional(),
  userCode: z.string().optional(),
});

export const authOutputSchema = {
  action: z.string(),
  summary: z.string().describe("One line: what just happened / what to do next"),
  newToken: z.string().optional().describe("Present when the endpoint token was rolled - update every client's Bearer token NOW; the old one is dead"),
  consentUrl: z.string().optional(),
  verificationUrl: z.string().optional(),
  userCode: z.string().optional(),
  endpoint: z.object({ state: z.enum(["ok", "not_applicable"]), note: z.string() }),
  google: googleDomain,
  feed: feedDomain,
};

type GoogleView = z.infer<typeof googleDomain>;
type FeedView = z.infer<typeof feedDomain>;

function feedView(): FeedView {
  const f = getFeedAuthState();
  const base = {
    state: f.state,
    nextAction: f.state === "signed_in" ? ("none" as const) : f.state === "sign_in_pending" ? ("wait_for_user" as const) : ("start_feed_auth" as const),
    instructions:
      f.state === "signed_in"
        ? "Feed sign-in active: get_my_feed and get_my_notifications are available."
        : f.state === "sign_in_pending"
          ? `Waiting for the account owner to enter code ${f.pending?.userCode ?? ""} at ${f.pending?.verificationUrl ?? "the verification URL"}.`
          : "Optional: personalized home feed and notifications need a one-time device-code sign-in. start with domain 'feed'.",
  };
  return f.pending ? { ...base, verificationUrl: f.pending.verificationUrl, userCode: f.pending.userCode } : base;
}

function googleView(s: AuthStatus): GoogleView {
  const base: GoogleView = {
    state: s.state,
    tokenSource: s.tokenSource,
    account: s.account,
    nextAction: s.nextAction,
    instructions: s.instructions,
  };
  if (s.consentUrl !== undefined) base.consentUrl = s.consentUrl;
  if (s.consentExpiresAt !== undefined) base.consentExpiresAt = s.consentExpiresAt;
  return base;
}

async function envelope(action: string, summary: string, extra: Record<string, unknown> = {}) {
  const google = googleView(await getAuthStatus());
  const feed = feedView();
  const structuredContent = {
    action,
    summary,
    ...extra,
    endpoint: endpointDomainStatus(),
    google,
    feed,
  };
  const text = [
    `🔐 auth(${action}): ${summary}`,
    extra.newToken ? `NEW ENDPOINT TOKEN: ${extra.newToken} - update every client now; the old token is dead.` : null,
    ``,
    `endpoint: ${structuredContent.endpoint.state} - ${structuredContent.endpoint.note}`,
    `google: ${google.state} - next: ${google.instructions}`,
    `feed: ${feed.state} - next: ${feed.instructions}`,
  ].filter((l): l is string => l !== null).join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent };
}

export async function authTool(args: z.infer<typeof authSchema>, extra?: { signal?: AbortSignal }) {
  try {
    const action = args.action ?? "status";
    const domain = args.domain;

    if (action === "status") {
      if (domain) throw new YouTubeError("INVALID_INPUT", "status ignores domain; it always returns all three domains. Call auth() with no arguments.");
      return envelope("status", "Current state of endpoint token, google account, and feed session.");
    }

    if (action === "start") {
      if (domain === "google") {
        const started = await startAuth(extra?.signal);
        return envelope("start", "Google consent URL issued; valid ~15 minutes.", {
          consentUrl: started.consentUrl,
        });
      }
      if (domain === "feed") {
        const code = await startFeedAuth(extra?.signal);
        return envelope("start", `Feed device-code issued; expires in ${code.expiresInMinutes} minutes.`, {
          verificationUrl: code.verificationUrl,
          userCode: code.userCode,
        });
      }
      throw new YouTubeError("INVALID_INPUT", "start applies to domain 'google' or 'feed'. For the endpoint token there is nothing to start; use action 'roll' to rotate it.");
    }

    if (action === "complete") {
      if (domain !== "google" || !args.redirectUrl) {
        throw new YouTubeError("INVALID_INPUT", "complete applies to domain 'google' and needs redirectUrl (the localhost address after Allow). The feed flow completes by itself once the user enters the device code.");
      }
      const done = await completeAuth(args.redirectUrl, extra?.signal);
      // Privilege just increased: devalue the possibly-shared install-era token.
      const newToken = rollEndpointToken();
      return envelope(
        "complete",
        `Authenticated as "${done.account?.title ?? "unknown"}". Endpoint token ROLLED - every client must switch to the new token now.`,
        { newToken },
      );
    }

    if (action === "roll") {
      if (domain !== "endpoint") throw new YouTubeError("INVALID_INPUT", "roll applies to the endpoint token only (domain 'endpoint').");
      if (!args.confirm) {
        throw new YouTubeError("INVALID_INPUT", "roll requires confirm=true: it instantly invalidates the current token; every client 401s until reconfigured with the new one this response returns.");
      }
      const newToken = rollEndpointToken();
      return envelope("roll", "Endpoint token rolled; old one is dead from the next request.", { newToken });
    }

    if (action === "reset") {
      if (!args.confirm) {
        throw new YouTubeError("INVALID_INPUT", "reset requires confirm=true: it signs out the google account and the feed session (endpoint token is kept so clients stay connected).");
      }
      const { clearFeedAuth } = await import("../utils/youtube-feed.js");
      await clearFeedAuth();
      const status = await resetAuth(false, extra?.signal);
      return envelope("reset", `Signed out everywhere google/feed. ${status.instructions}`);
    }

    throw new YouTubeError("INVALID_INPUT", `Unknown action ${String(action)}`);
  } catch (err: unknown) {
    return errorResult(err);
  }
}
