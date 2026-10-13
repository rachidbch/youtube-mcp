import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import { startFeedAuth } from "../utils/youtube-feed.js";

export const startFeedAuthOutputSchema = {
  verificationUrl: z.string().describe("Open this in any browser, sign in as the account owner"),
  userCode: z.string().describe("Enter this code on the verification page"),
  expiresInMinutes: z.number(),
  nextAction: z.literal("wait_then_get_my_feed"),
  instructions: z.string(),
};

export async function startFeedAuthTool(_args: Record<string, never>, extra?: { signal?: AbortSignal }) {
  try {
    const code = await startFeedAuth(extra?.signal);
    const instructions =
      `Send the account owner to the verification URL (any device with a browser) and have them enter the code. ` +
      `This signs the server into YouTube once (device-code login, like a smart TV) for personalized home feed and notifications. ` +
      `Progress is visible in get_auth_status.feedAuth; when it shows signed_in, call get_my_feed / get_my_notifications.`;
    const text = [
      `📺 Feed/notifications sign-in started.`,
      ``,
      `1. Open: ${code.verificationUrl}`,
      `2. Enter code: ${code.userCode}`,
      ``,
      `Code expires in ${code.expiresInMinutes} minutes. ${instructions}`,
    ].join("\n");
    const structuredContent = {
      verificationUrl: code.verificationUrl,
      userCode: code.userCode,
      expiresInMinutes: code.expiresInMinutes,
      nextAction: "wait_then_get_my_feed" as const,
      instructions,
    };
    return { content: [{ type: "text" as const, text }], structuredContent };
  } catch (err: unknown) {
    return errorResult(err);
  }
}
