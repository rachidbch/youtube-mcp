import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import { getAuthStatus } from "../utils/google-account.js";

export const getAuthStatusOutputSchema = {
  state: z.enum(["not_configured", "not_authenticated", "consent_pending", "authenticated", "expired"]),
  tokenSource: z.enum(["file", "env"]).nullable(),
  account: z.object({ title: z.string().nullable(), channelId: z.string().nullable() }).nullable(),
  nextAction: z.enum(["install_client_credentials", "start_auth", "complete_auth", "none"]),
  instructions: z.string().describe("What an agent should do next, phrased for direct execution"),
  consentUrl: z.string().optional(),
  consentExpiresAt: z.number().optional(),
};

export async function getAuthStatusTool(_args: Record<string, never>, extra?: { signal?: AbortSignal }) {
  try {
    const status = await getAuthStatus(extra?.signal);
    const text = [
      `🔐 Google auth state: ${status.state}${status.tokenSource ? ` (token from ${status.tokenSource})` : ""}`,
      status.account?.title ? `Account: ${status.account.title}` : null,
      `Next: ${status.instructions}`,
      status.consentUrl ? `\nConsent URL (valid until ${new Date(status.consentExpiresAt ?? 0).toISOString()}):\n${status.consentUrl}` : null,
    ].filter((l): l is string => l !== null).join("\n");

    const structuredContent: Record<string, unknown> = {
      state: status.state,
      tokenSource: status.tokenSource,
      account: status.account,
      nextAction: status.nextAction,
      instructions: status.instructions,
    };
    if (status.consentUrl !== undefined) structuredContent.consentUrl = status.consentUrl;
    if (status.consentExpiresAt !== undefined) structuredContent.consentExpiresAt = status.consentExpiresAt;

    return { content: [{ type: "text" as const, text }], structuredContent };
  } catch (err: unknown) {
    return errorResult(err);
  }
}

export const getAuthStatusToolSchema = z.object({});
