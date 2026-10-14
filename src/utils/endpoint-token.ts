import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "./logger.js";

/**
 * The server owns its HTTP endpoint token: generated on first start, stored
 * (mode 600) next to the auth state, never taken from the environment, and
 * rolled instantly via the auth tool (old token dies on the next request).
 * Every request re-reads the current token, so rolls apply without restart.
 */

let currentToken: string | null = null;
let httpMode = false;

export function setHttpMode(on: boolean): void {
  httpMode = on;
}

export function tokenFilePath(): string {
  return resolve(process.env.YT_TOKEN_FILE ?? join(process.cwd(), ".youtube-mcp-token"));
}

function writeTokenFile(token: string): void {
  const path = tokenFilePath();
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, token + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Load-or-generate at startup; logs the token once for the installing agent. */
export function ensureEndpointToken(): string {
  if (currentToken) return currentToken;
  const path = tokenFilePath();
  try {
    const stored = readFileSync(path, "utf8").trim();
    if (stored.length >= 32) {
      currentToken = stored;
      logger.info(`Endpoint token loaded from ${path}`);
      return currentToken;
    }
  } catch {
    /* no file yet */
  }
  currentToken = randomBytes(32).toString("hex");
  writeTokenFile(currentToken);
  // Unmissable, greppable line for installers (cloudify pkg reads this or the file).
  logger.info(
    `[ENDPOINT TOKEN] ${currentToken} | clients must send "Authorization: Bearer <token>" | stored at ${path} | roll it with the auth tool`,
  );
  return currentToken;
}

export function getCurrentEndpointToken(): string | null {
  return currentToken;
}

/** Roll: new token, persisted, old one dead from the next request. Returns the new token. */
export function rollEndpointToken(): string {
  const fresh = randomBytes(32).toString("hex");
  writeTokenFile(fresh);
  currentToken = fresh;
  logger.info("Endpoint token rolled");
  return fresh;
}

export function endpointDomainStatus(): { state: "ok" | "not_applicable"; note: string } {
  if (!httpMode) {
    return {
      state: "not_applicable",
      note: "Server runs on stdio; there is no HTTP endpoint token. Domain 'endpoint' actions (roll) apply to HTTP deployments only.",
    };
  }
  return {
    state: "ok",
    note: `Token active (stored at ${tokenFilePath()}). Every client must send it as a Bearer token. It rolls instantly when google auth completes or on auth(action=roll); holders of an old token get 401.`,
  };
}
