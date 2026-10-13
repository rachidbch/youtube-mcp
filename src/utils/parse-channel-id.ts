const CHANNEL_ID = /^UC[a-zA-Z0-9_-]{22}$/;
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

/**
 * A parsed channel reference: either a UC... channel ID, or a URL that
 * youtubei.js's resolveURL() can turn into one (@handle, /c/, /user/ paths).
 */
export type ChannelRef =
  | { kind: "id"; channel: string }
  | { kind: "url"; url: string };

/**
 * Parse channel input into a resolvable reference.
 * Accepts: UC... IDs, full channel URLs (any YouTube host), bare @handles.
 * Everything non-UC is resolved later via the library's resolveURL, so
 * @handle, /c/name, /user/name and /channel/UC... paths all work.
 */
export function parseChannelRef(input: string): ChannelRef {
  const trimmed = input.trim();

  if (CHANNEL_ID.test(trimmed)) {
    return { kind: "id", channel: trimmed };
  }

  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }

  if (url && (url.protocol === "https:" || url.protocol === "http:")) {
    const host = url.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(host)) {
      throw channelError(input);
    }
    // Direct /channel/UC... form: extract the ID without a resolution request.
    const channelMatch = url.pathname.match(/^\/channel\/(UC[a-zA-Z0-9_-]{22})/);
    if (channelMatch) {
      return { kind: "id", channel: channelMatch[1] };
    }
    // Any other non-empty path (@handle, /c/, /user/) is resolvable by YouTube.
    // Drop channel-tab suffixes (/videos, /shorts, ...) so resolveURL gets the channel root.
    const path = url.pathname.replace(/\/(videos|shorts|streams|live|playlists|podcasts|community|store|about|featured)\/?$/, "");
    if (path !== "/") {
      return { kind: "url", url: `https://www.youtube.com${path}` };
    }
    throw channelError(input);
  }

  if (HANDLE.test(trimmed)) {
    return { kind: "url", url: `https://www.youtube.com/${trimmed}` };
  }

  throw channelError(input);
}

function channelError(input: string): Error {
  return new Error(
    `Could not parse channel from: "${input}". Provide a UC... channel ID, an @handle, or a channel URL (youtube.com/@handle, /c/name, /user/name, /channel/UC...).`,
  );
}
