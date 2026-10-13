import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import { completeAuth } from "../utils/google-account.js";

export const completeAuthSchema = z.object({
  redirectUrl: z
    .string()
    .min(10, "The redirect URL (or bare code) from the browser is required")
    .describe("The full address of the localhost page the browser landed on after Allow (it contains ?code=...&state=...), or the bare authorization code"),
});

export const completeAuthOutputSchema = {
  state: z.literal("authenticated"),
  tokenSource: z.literal("file"),
  account: z.object({ title: z.string().nullable(), channelId: z.string().nullable() }),
  nextAction: z.enum(["none"]),
  instructions: z.string(),
};

export async function completeAuthTool(args: z.infer<typeof completeAuthSchema>, extra?: { signal?: AbortSignal }) {
  try {
    const status = await completeAuth(args.redirectUrl, extra?.signal);
    const text = [
      `🔐 Authenticated${status.account?.title ? ` as "${status.account.title}"` : ""}.`,
      `Token stored server-side (file, mode 600). ${status.instructions}`,
    ].join("\n");

    const structuredContent = {
      state: status.state,
      tokenSource: status.tokenSource,
      account: status.account,
      nextAction: status.nextAction,
      instructions: status.instructions,
    };

    return { content: [{ type: "text" as const, text }], structuredContent };
  } catch (err: unknown) {
    return errorResult(err);
  }
}
