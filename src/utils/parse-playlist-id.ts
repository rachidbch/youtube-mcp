const PLAYLIST_ID = /^[A-Za-z0-9_-]{13,}$/;
// Built-in account-scoped playlists have short IDs; they are unreachable
// anonymously, but parse them so the fetcher can report that clearly.
const BUILTIN_ID = /^(WL|LL)$/;

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
 * Extract a playlist ID from a YouTube URL (the `list=` parameter) or accept
 * a bare playlist ID (PL..., OL..., RD..., or built-in WL/LL).
 */
export function parsePlaylistId(input: string): string {
  const trimmed = input.trim();

  if (PLAYLIST_ID.test(trimmed) || BUILTIN_ID.test(trimmed)) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw playlistError(input);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw playlistError(input);
  }
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    throw playlistError(input);
  }

  const list = url.searchParams.get("list");
  if (list && (PLAYLIST_ID.test(list) || BUILTIN_ID.test(list))) {
    return list;
  }

  throw playlistError(input);
}

function playlistError(input: string): Error {
  return new Error(
    `Could not extract playlist ID from: "${input}". Provide a playlist URL (must contain a valid list= parameter) or a playlist ID (e.g. PL...).`,
  );
}
