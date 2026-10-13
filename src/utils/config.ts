/**
 * Operational limits, read once from the environment at startup.
 * Invalid values fail fast so a misconfigured server never starts half-working.
 */
export interface Config {
  /** Deadline for creating the shared youtubei.js client. */
  initTimeoutMs: number;
  /** Deadline for one tool call's upstream work, including waiting for client init. */
  requestTimeoutMs: number;
  /** Maximum bytes read from each response fetched for captions (watch page, player JSON, caption track). */
  transcriptMaxBytes: number;
  /** Maximum caption segments processed from one track. */
  transcriptMaxSegments: number;
  /** Maximum caption segments returned in one get_video_transcript response. */
  transcriptPageMaxSegments: number;
  /** Preferred caption languages, best match first, when a call omits `lang` (e.g. ["en", "en-US"]). */
  defaultTranscriptLangs: string[];
  /** Google OAuth client for account tools. null = anonymous install. */
  googleClient: { clientId: string; clientSecret: string } | null;
  /** Refresh token provided at install time (optional; tokens can also be acquired at runtime via the auth tools). */
  googleRefreshTokenEnv: string | null;
}

const DEFAULTS: Config = {
  initTimeoutMs: 15_000,
  requestTimeoutMs: 20_000,
  transcriptMaxBytes: 5_000_000,
  transcriptMaxSegments: 50_000,
  transcriptPageMaxSegments: 500,
  defaultTranscriptLangs: ["en"],
  googleClient: null,
  googleRefreshTokenEnv: null,
};

const ENV_KEYS: Omit<Record<keyof Config, string>, "googleClient" | "googleRefreshTokenEnv"> = {
  initTimeoutMs: "YT_INIT_TIMEOUT_MS",
  requestTimeoutMs: "YT_REQUEST_TIMEOUT_MS",
  transcriptMaxBytes: "YT_TRANSCRIPT_MAX_BYTES",
  transcriptMaxSegments: "YT_TRANSCRIPT_MAX_SEGMENTS",
  transcriptPageMaxSegments: "YT_TRANSCRIPT_PAGE_MAX_SEGMENTS",
  defaultTranscriptLangs: "YT_DEFAULT_LANGS",
};

const ACCOUNT_ENV_KEYS = ["YT_GOOGLE_CLIENT_ID", "YT_GOOGLE_CLIENT_SECRET", "YT_GOOGLE_REFRESH_TOKEN"] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(ENV_KEYS) as Array<keyof typeof ENV_KEYS>) {
    if (key === "defaultTranscriptLangs") continue; // parsed separately below
    const name = ENV_KEYS[key];
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
      throw new Error(`Invalid ${name}="${raw}": expected a positive integer`);
    }
    config[key] = Number(raw);
  }
  {
    const raw = env[ENV_KEYS.defaultTranscriptLangs];
    if (raw !== undefined && raw.trim() !== "") {
      const langs = raw.split(",").map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0);
      if (langs.length === 0 || langs.some((l) => !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(l))) {
        throw new Error(`Invalid ${ENV_KEYS.defaultTranscriptLangs}="${raw}": expected comma-separated BCP-47 language codes, e.g. "en" or "en,pt-BR"`);
      }
      config.defaultTranscriptLangs = langs;
    }
  }
  {
    const id = env.YT_GOOGLE_CLIENT_ID?.trim();
    const secret = env.YT_GOOGLE_CLIENT_SECRET?.trim();
    const refreshToken = env.YT_GOOGLE_REFRESH_TOKEN?.trim();
    if (id && !secret) {
      throw new Error("Invalid account auth configuration: YT_GOOGLE_CLIENT_ID is set but YT_GOOGLE_CLIENT_SECRET is missing.");
    }
    if (secret && !id) {
      throw new Error("Invalid account auth configuration: YT_GOOGLE_CLIENT_SECRET is set but YT_GOOGLE_CLIENT_ID is missing.");
    }
    if (refreshToken && !(id && secret)) {
      throw new Error(
        "Invalid account auth configuration: YT_GOOGLE_REFRESH_TOKEN is set but the OAuth client (YT_GOOGLE_CLIENT_ID/SECRET) is missing. " +
          "Set the client too, or drop the token and use the auth tools (start_auth) instead.",
      );
    }
    if (id && secret) {
      config.googleClient = { clientId: id, clientSecret: secret };
      config.googleRefreshTokenEnv = refreshToken || null;
    }
  }
  return config;
}

export const config: Config = loadConfig();
