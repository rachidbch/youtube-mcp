// Offline test helpers: a fake globalThis.fetch with per-URL routes, plus YouTube-shaped fixtures.
// Tests import the compiled server from dist/ (run `npm run build` first; `npm test` does).

export const VIDEO_ID = "AAAAAAAAAAA";

/**
 * Replace globalThis.fetch. routes: [[matcher, handler], ...] where matcher is a RegExp
 * tested against the URL and handler(url, init) returns a Response (or a promise).
 * Unmatched requests fail the test loudly. Honors init.signal like real fetch.
 */
export function installFakeFetch(routes) {
  const calls = [];
  let pending = 0;
  const original = globalThis.fetch;

  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    calls.push({ url, method, body: typeof init.body === "string" ? init.body : undefined });
    const signal = init.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);

    const route = routes.find(([m]) => m.test(url));
    if (!route) return Promise.reject(new Error(`fake fetch: no route for ${method} ${url}`));

    pending++;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => route[1](url, init))
        .then(resolve, reject)
        .finally(() => {
          pending--;
          signal?.removeEventListener("abort", onAbort);
        });
    });
  };

  return {
    calls,
    get pending() { return pending; },
    restore() { globalThis.fetch = original; },
  };
}

/** A handler that never answers until the request's signal aborts. */
export function hang() {
  return (_url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
}

export const status = (code, body = "") => () => new Response(body, { status: code });
export const json = (obj) => () => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
export const text = (body) => () => new Response(body, { status: 200 });

export const WATCH_PAGE = `<html><script>ytcfg.set({"INNERTUBE_API_KEY":"AIzaFAKEKEY","INNERTUBE_CLIENT_VERSION":"2.0"});</script></html>`;
export const CAPTCHA_PAGE = `<html><form><div class="g-recaptcha" data-sitekey="x"></div></form></html>`;

export function track(languageCode, name, kind, { runs = false } = {}) {
  return {
    baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=${languageCode}${kind ? `&kind=${kind}` : ""}&fmt=srv3`,
    name: runs ? { runs: [{ text: name }] } : { simpleText: name },
    languageCode,
    ...(kind && { kind }),
  };
}

export function playerResponse({ status = "OK", reason, tracks, videoId = VIDEO_ID } = {}) {
  return {
    playabilityStatus: { status, ...(reason && { reason }) },
    ...(tracks && { captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } }),
    videoDetails: { videoId },
  };
}

// Legacy timedtext XML (what the library requests after stripping fmt=).
export const MANUAL_XML = `<?xml version="1.0" encoding="utf-8" ?><transcript>` +
  `<text start="0.5" dur="2.1">Hello &amp;amp; welcome</text>` +
  `<text start="2.6" dur="1.9">I&amp;#39;m &amp;quot;here&amp;quot; &amp;#x1F600;</text>` +
  `<text start="3725.0" dur="3.0">last line</text>` +
  `</transcript>`;

export const ASR_XML = `<?xml version="1.0" encoding="utf-8" ?><transcript>` +
  `<text start="0" dur="1.5">hola</text>` +
  `<text start="1.5" dur="1.5">mundo</text>` +
  `</transcript>`;

/** Standard transcript routes; override any piece via opts. */
export function transcriptRoutes({ watch = text(WATCH_PAGE), player, timedtext } = {}) {
  return [
    [/youtube\.com\/watch\?/, watch],
    [/youtubei\/v1\/player/, player ?? json(playerResponse({ tracks: [track("en", "English"), track("es", "Spanish (auto-generated)", "asr", { runs: true })] }))],
    [/api\/timedtext.*kind=asr/, timedtext ?? text(ASR_XML)],
    [/api\/timedtext/, timedtext ?? text(MANUAL_XML)],
  ];
}

/** The machine-readable error of an isError result. */
export function errOf(result) {
  if (result.isError !== true) throw new Error(`expected error result, got ${JSON.stringify(result.structuredContent)}`);
  return result._meta["youtube-mcp/error"];
}

/** Call a tool handler directly, as McpServer would. */
export async function callTool(handler, args, signal) {
  return handler(args, { signal: signal ?? new AbortController().signal });
}

/** Resources that would keep the process alive (timers, sockets), minus a baseline. */
export function activeHandlesSince(baseline) {
  const now = process.getActiveResourcesInfo().filter((r) => r !== "TTYWrap" && r !== "PipeWrap");
  const counts = {};
  for (const r of baseline) counts[r] = (counts[r] ?? 0) + 1;
  return now.filter((r) => {
    if (counts[r] > 0) { counts[r]--; return false; }
    return true;
  });
}
