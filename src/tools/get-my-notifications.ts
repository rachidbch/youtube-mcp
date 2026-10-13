import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import { fetchMyNotifications } from "../utils/youtube-feed.js";

export const getMyNotificationsOutputSchema = {
  notifications: z.array(z.object({
    title: z.string(),
    sentText: z.string().nullable().describe("e.g. '2 hours ago'"),
    read: z.boolean().nullable(),
    videoUrl: z.string().nullable().describe("null when the notification is not about a video"),
    channelName: z.string().nullable(),
  })),
  note: z.string().nullable().describe("Present when nothing could be parsed (not an auth problem)"),
};

export async function getMyNotificationsTool(_args: Record<string, never>, extra?: { signal?: AbortSignal }) {
  try {
    const { notifications, note } = await fetchMyNotifications(extra?.signal);
    const text = [
      `🔔 Your notifications — ${notifications.length}${note ? ` (note: ${note})` : ""}:`,
      ``,
      ...notifications.map((n) => `- ${n.title}${n.sentText ? ` (${n.sentText})` : ""}${n.videoUrl ? ` — ${n.videoUrl}` : ""}`),
    ].join("\n");
    const structuredContent = { notifications: notifications.map((n) => ({ ...n })), note };
    return { content: [{ type: "text" as const, text }], structuredContent };
  } catch (err: unknown) {
    return errorResult(err);
  }
}
