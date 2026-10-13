import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import { getAuthStatus } from "../utils/google-account.js";
import { getFeedAuthState } from "../utils/youtube-feed.js";

export const getAuthStatusOutputSchema = {
  state: z.enum(["not_configured", "not_authenticated", "consent_pending", "authenticated", "expired"]),
  tokenSource: z.enum(["file", "env"]).nullable(),
  account: z.object({ title: z.string().nullable(), channelId: z.string().nullable() }).nullable(),
  nextAction: z.enum(["install_client_credentials", "start_auth", "complete_auth", "none"]),
  instructions: z.string().describe("What an agent should do next, phrased for direct execution"),
  consentUrl: z.string().optional(),
  consentExpiresAt: z.number().optional(),
  feedAuth: z.object({
    state: z.enum(["signed_out", "sign_in_pending", "signed_in"]),
    nextAction: z.enum(["start_feed_auth", "wait_for_user", "none"]),
    instructions: z.string(),
    verificationUrl: z.string().optional(),
    userCode: z.string().optional(),
  }).describe("Separate one-time YouTube sign-in for personalized home feed and notifications (device-code login)"),
};

export async function getAuthStatusTool(_args: Record<string, never>, extra?: { signal?: AbortSignal }) {
  try {
    const status = await getAuthStatus(extra?.signal);
    const feed = getFeedAuthState();
    const feedAuth = {
      state: feed.state,
      nextAction: feed.state === "signed_in" ? "none" : feed.state === "sign_in_pending" ? "wait_for_user" : "start_feed_auth",
      instructions:
        feed.state === "signed_in"
          ? "Feed/notifications sign-in active: get_my_feed and get_my_notifications are available."
          : feed.state === "sign_in_pending"
            ? `Waiting for the account owner to enter code ${feed.pending?.userCode ?? ""} at ${feed.pending?.verificationUrl ?? "the verification URL"}. Then call get_my_feed / get_my_notifications.`
            : "Optional: personalized home feed and notifications need a separate one-time sign-in. Call start_feed_auth to begin (device-code login, any browser).",
      ...(feed.pending ? { verificationUrl: feed.pending.verificationUrl, userCode: feed.pending.userCode } : {}),
    };
    const text = [
      `🔐 Google auth state: ${status.state}${status.tokenSource ? ` (token from ${status.tokenSource})` : ""}`,
      status.account?.title ? `Account: ${status.account.title}` : null,
      `Next: ${status.instructions}`,
      status.consentUrl ? `\nConsent URL (valid until ${new Date(status.consentExpiresAt ?? 0).toISOString()}):\n${status.consentUrl}` : null,
      ``,
      `📺 Feed/notifications auth: ${feedAuth.state} — ${feedAuth.instructions}`,
    ].filter((l): l is string => l !== null).join("\n");

    const structuredContent: Record<string, unknown> = {
      state: status.state,
      tokenSource: status.tokenSource,
      account: status.account,
      nextAction: status.nextAction,
      instructions: status.instructions,
      feedAuth,
    };
    if (status.consentUrl !== undefined) structuredContent.consentUrl = status.consentUrl;
    if (status.consentExpiresAt !== undefined) structuredContent.consentExpiresAt = status.consentExpiresAt;

    return { content: [{ type: "text" as const, text }], structuredContent };
  } catch (err: unknown) {
    return errorResult(err);
  }
}

export const getAuthStatusToolSchema = z.object({});
