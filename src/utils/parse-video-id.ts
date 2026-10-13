const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);

/**
 * Extract a YouTube video ID from various URL formats or a plain ID string.
 * Supports: watch URLs, youtu.be short links, embed URLs, shorts URLs, live URLs, and plain IDs.
 * Only YouTube hosts are accepted, and the extracted ID must be 11 valid characters.
 */
export function parseVideoId(input: string): string {
  const trimmed = input.trim();

  // Plain video ID (11 characters, alphanumeric + dash + underscore)
  if (VIDEO_ID.test(trimmed)) {
    return trimmed;
  }

  const candidate = extractCandidate(trimmed);
  if (candidate !== null && VIDEO_ID.test(candidate)) {
    return candidate;
  }

  throw new Error(
    `Could not extract video ID from: "${input}". Provide a YouTube URL or an 11-character video ID.`
  );
}

function extractCandidate(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null; // not a valid URL
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  const pathSegments = url.pathname.split("/").filter(Boolean);

  // youtu.be/VIDEO_ID
  if (host === "youtu.be") {
    return pathSegments.length === 1 ? pathSegments[0] : null;
  }

  // youtube.com/watch?v=VIDEO_ID
  if (pathSegments.length === 1 && pathSegments[0] === "watch") {
    return url.searchParams.get("v");
  }

  // youtube.com/{embed,v,shorts,live}/VIDEO_ID
  if (
    pathSegments.length === 2 &&
    ["embed", "v", "shorts", "live"].includes(pathSegments[0])
  ) {
    return pathSegments[1];
  }

  return null;
}
