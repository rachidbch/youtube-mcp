import { AsyncLocalStorage } from "node:async_hooks";
import { errorFromHttpStatus, YouTubeError, type PlayabilityStatus } from "./errors.js";

/**
 * Per-call state. Every upstream fetch made while a tool call runs (by youtubei.js
 * or youtube-transcript-plus) picks up the call's AbortSignal from here, so a
 * timeout or MCP cancellation aborts the real HTTP work instead of racing it.
 */
export interface CallContext {
  signal: AbortSignal;
  /** Playability status seen in the transcript library's player response. */
  playability?: PlayabilityStatus;
  /** Caption tracks seen in the transcript library's player response. */
  captionTracks?: Array<{ languageCode: string; kind?: string; name?: string }>;
  /** Byte length of the last caption track body downloaded. */
  captionBodyBytes?: number;
}

const storage = new AsyncLocalStorage<CallContext>();

const shutdownController = new AbortController();

/** Abort all in-flight and future upstream work (process shutdown). */
export function abortAll(): void {
  if (!shutdownController.signal.aborted) {
    shutdownController.abort(new YouTubeError("CANCELLED", "Server is shutting down"));
  }
}

export function currentContext(): CallContext | undefined {
  return storage.getStore();
}

/** Run fn with a context whose signal is used by contextFetch. */
export function runInContext<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * Run upstream work with a deadline, linked to the caller's signal (MCP cancellation)
 * and to process shutdown. The timer and listeners are always removed on exit.
 */
export async function runWithDeadline<T>(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new YouTubeError("CANCELLED", `${label} was cancelled`));
  const parents = [parent, shutdownController.signal].filter((s): s is AbortSignal => !!s);

  for (const p of parents) {
    if (p.aborted) {
      throw p === shutdownController.signal ? p.reason : new YouTubeError("CANCELLED", `${label} was cancelled`);
    }
    p.addEventListener("abort", cancel, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new YouTubeError("TIMEOUT", `${label} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  try {
    return await storage.run({ signal: controller.signal }, () => fn(controller.signal));
  } catch (err) {
    // Whatever the libraries wrapped the abort in, report the abort reason itself.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
    for (const p of parents) p.removeEventListener("abort", cancel);
  }
}

/** Resolve with the promise, or reject as soon as the signal aborts. Leaves no listener behind. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/**
 * fetch() bound to the current call's signal. 403/429 from YouTube become
 * ACCESS_BLOCKED here, before any library can relabel them.
 * globalThis.fetch is looked up per call so tests can substitute it.
 */
export async function contextFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const signal = storage.getStore()?.signal ?? shutdownController.signal;
  if (signal.aborted) throw signal.reason;

  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let response: Response;
  try {
    response = await globalThis.fetch(input, { ...init, signal });
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    const msg = err instanceof Error ? err.message : String(err);
    throw new YouTubeError("UPSTREAM_ERROR", `Network error contacting YouTube: ${msg}`);
  }

  if (response.status === 403 || response.status === 429) {
    await response.body?.cancel().catch(() => {});
    throw errorFromHttpStatus(response.status, url);
  }
  return response;
}

/** Read a response body as text, failing once it exceeds maxBytes. */
export async function readTextLimited(response: Response, maxBytes: number, what: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new YouTubeError("LIMIT_EXCEEDED", `${what} exceeded ${maxBytes} bytes (YT_TRANSCRIPT_MAX_BYTES)`);
      }
      chunks.push(value);
    }
  } catch (err) {
    const signal = storage.getStore()?.signal;
    if (signal?.aborted) throw signal.reason;
    throw err;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
