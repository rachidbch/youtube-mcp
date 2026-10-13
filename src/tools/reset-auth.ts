import { z } from "zod";
import { errorResult, YouTubeError } from "../utils/errors.js";
import { resetAuth } from "../utils/google-account.js";

export const resetAuthSchema = z.object({
  confirm: z
    .boolean()
    .default(false)
    .describe("Must be true to actually reset; false returns an explanation (safety against accidental calls)"),
  revoke: z
    .boolean()
    .default(true)
    .describe("Also revoke the refresh token at Google (recommended; the local copy is dropped either way)"),
});

export const resetAuthOutputSchema = {
  state: z.enum(["not_authenticated", "not_configured"]),
  nextAction: z.enum(["start_auth", "install_client_credentials"]),
  instructions: z.string(),
};

export async function resetAuthTool(args: z.infer<typeof resetAuthSchema>, extra?: { signal?: AbortSignal }) {
  if (!args.confirm) {
    return errorResult(
      new YouTubeError(
        "INVALID_INPUT",
        "reset_auth requires confirm=true. It drops the stored Google token" +
          (args.revoke ? " and revokes it at Google" : "") +
          ". Account tools stop working until a new consent completes. Re-call with confirm=true to proceed.",
      ),
    );
  }
  try {
    const status = await resetAuth(args.revoke, extra?.signal);
    const text = [`🔐 Auth reset. ${status.instructions}`].join("\n");
    const structuredContent = {
      state: status.state,
      nextAction: status.nextAction,
      instructions: status.instructions,
    };
    return { content: [{ type: "text" as const, text }], structuredContent };
  } catch (err: unknown) {
    return errorResult(err);
  }
}
