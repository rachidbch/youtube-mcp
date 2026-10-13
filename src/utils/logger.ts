type LogLevel = "INFO" | "WARN" | "ERROR";

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  process.stderr.write(`[${ts}] [${level}] ${message}${metaStr}\n`);
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => log("INFO", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("WARN", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("ERROR", message, meta),
};

/** Wraps a tool handler to log invocation, duration, and errors */
export function withLogging<T extends Record<string, unknown>, E, R>(
  toolName: string,
  handler: (args: T, extra: E) => Promise<R>
): (args: T, extra: E) => Promise<R> {
  return async (args: T, extra: E): Promise<R> => {
    const start = Date.now();
    try {
      const result = await handler(args, extra);
      const error = errorOf(result);
      if (error) {
        logger.warn(`Tool: ${toolName} returned error`, { durationMs: Date.now() - start, ...error });
      } else {
        logger.info(`Tool: ${toolName}`, { durationMs: Date.now() - start });
      }
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Tool: ${toolName} failed`, { durationMs: Date.now() - start, error: msg });
      throw err;
    }
  };
}

function errorOf(result: unknown): Record<string, unknown> | undefined {
  const r = result as { isError?: boolean; _meta?: Record<string, Record<string, unknown>> } | undefined;
  if (!r?.isError) return undefined;
  return r._meta?.["youtube-mcp/error"] ?? { error: "isError" };
}
