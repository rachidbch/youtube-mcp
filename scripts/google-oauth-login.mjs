#!/usr/bin/env node
/**
 * One-time Google OAuth login for authenticated mode ("my playlists").
 *
 * Prerequisites (Google Cloud Console, ~10 minutes, once):
 *   1. Create (or pick) a project at https://console.cloud.google.com/
 *   2. APIs & Services -> Library -> enable "YouTube Data API v3"
 *   3. APIs & Services -> OAuth consent screen:
 *      - User type: External, fill in app name + your email
 *      - Add yourself as a TEST user (skips Google's app review entirely)
 *   4. APIs & Services -> Credentials -> Create credentials -> OAuth client ID
 *      - Application type: "Desktop app" -> create -> note Client ID and Secret
 *
 * Then run this script on a machine with a browser:
 *   YT_GOOGLE_CLIENT_ID=... YT_GOOGLE_CLIENT_SECRET=... node scripts/google-oauth-login.mjs
 *
 * It opens a Google consent page (or prints the URL), you click Allow,
 * and it prints the env lines to paste into your systemd unit / .env:
 *   YT_GOOGLE_CLIENT_ID=...
 *   YT_GOOGLE_CLIENT_SECRET=...
 *   YT_GOOGLE_REFRESH_TOKEN=...
 *
 * Scope requested: youtube.readonly (read-only: playlists and playlist items).
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const PORT = 8479;
const clientId = process.env.YT_GOOGLE_CLIENT_ID;
const clientSecret = process.env.YT_GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set YT_GOOGLE_CLIENT_ID and YT_GOOGLE_CLIENT_SECRET first (see the header of this script).");
  process.exit(1);
}

const redirectUri = `http://localhost:${PORT}`;
const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // ask for a refresh token
    prompt: "consent",
  });

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const error = url.searchParams.get("error");
    const c = url.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(error ? "Consent denied - you can close this tab." : "Authorized - you can close this tab.");
    server.close();
    if (error) reject(new Error(`Consent denied: ${error}`));
    else if (c) resolve(c);
    else reject(new Error(`No code in redirect: ${req.url}`));
  });
  server.on("error", (e) => reject(new Error(`Cannot listen on ${redirectUri} (${e.code}). Close whatever uses port ${PORT} and retry.`)));
  server.listen(PORT, "127.0.0.1", async () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`Waiting for consent on ${url} ...`);
    console.log(`\nOpen this URL in your browser (same machine):\n\n${authUrl}\n`);
    try {
      execSync(
        process.platform === "darwin" ? `open "${authUrl}"` : `xdg-open "${authUrl}"`,
        { stdio: "ignore" },
      );
    } catch {
      /* no GUI - copy the URL manually */
    }
    await delay(5 * 60_000).then(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for consent."));
    });
  });
});

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }),
});
const tokens = await tokenRes.json();
if (!tokenRes.ok || !tokens.refresh_token) {
  console.error("Token exchange failed:", tokenRes.status, JSON.stringify(tokens).slice(0, 300));
  process.exit(1);
}

// Verify the refresh token actually works before telling the user to install it.
const checkRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
  }),
});
if (!checkRes.ok) {
  console.error("Refresh token verification failed:", checkRes.status, await checkRes.text());
  process.exit(1);
}

console.log("\nConsent obtained and refresh token verified. Add these to your server's environment:\n");
console.log(`YT_GOOGLE_CLIENT_ID=${clientId}`);
console.log(`YT_GOOGLE_CLIENT_SECRET=${clientSecret}`);
console.log(`YT_GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
console.log("\nRestart the server after setting them; list_my_playlists will then be available.");
