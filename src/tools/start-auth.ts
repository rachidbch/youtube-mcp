import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import { startAuth } from "../utils/google-account.js";

export const startAuthSchema = z.object({});

export const startAuthOutputSchema = {
  state: z.literal("consent_pending"),
  consentUrl: z.string().describe("Google consent page for the account owner (or an agent-driven browser)"),
  consentExpiresAt: z.number(),
  nextAction: z.literal("complete_auth"),
  instructions: z.string(),
};
export async function startAuthTool(_args: z.infer<typeof startAuthSchema>, extra?: { signal?: AbortSignal }) {
  try {
    const status = await startAuth(extra?.signal);
    const text = [
      `🔐 Auth flow started. Send the account owner to this URL (or open it in a browser you control):`,
      ``,
      status.consentUrl,
      ``,
      `After they click Allow, the browser lands on a localhost error page - that is expected (nothing listens there).`,
      `Copy that page's full address and pass it to complete_auth. Session expires ${new Date(status.consentExpiresAt ?? 0).toISOString()}.`,
    ].join("\n");

    const structuredContent = {
      state: status.state,
      consentUrl: status.consentUrl,
      consentExpiresAt: status.consentExpiresAt,
      nextAction: status.nextAction,
      instructions: status.instructions,
    };

    return { content: [{ type: "text" as const, text }], structuredContent };
  } catch (err: unknown) {
    return errorResult(err);
  }
}
