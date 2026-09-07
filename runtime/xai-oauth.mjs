import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));

// xAI's public desktop OAuth client (shared by the Grok Build CLI and the
// third-party agents xAI announced OAuth support for). It is a public client:
// no secret exists, so the device-code grant is the whole handshake.
export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_API_BASE_URL = "https://api.x.ai/v1";
export const XAI_SUBSCRIPTION_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;
const REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_SKEW_MS = 60_000;
const MIN_LIFETIME_MS = 5 * 60_000;
const ALLOWED_BEARER_HOSTS = new Set(["api.x.ai", "cli-chat-proxy.grok.com"]);

export class XaiAuthError extends Error {}

export function credentialsPath(config) {
  return config.xaiCredentialsPath || join(runtimeDirectory, "xai-oauth.json");
}

export async function loadCredentials(config) {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(config), "utf8"));
    if (typeof parsed?.access !== "string" || typeof parsed?.refresh !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCredentials(config, credentials) {
  const pathname = credentialsPath(config);
  await mkdir(dirname(pathname), { recursive: true, mode: 0o700 });
  await writeFile(pathname, JSON.stringify(credentials), { mode: 0o600 });
}

/** Refuses to send the subscription bearer token anywhere but xAI's own hosts. */
export function assertBearerOrigin(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new XaiAuthError(`refusing to send the xAI token to an invalid URL`);
  }
  if (parsed.protocol !== "https:" || !ALLOWED_BEARER_HOSTS.has(parsed.hostname)) {
    throw new XaiAuthError(`refusing to send the xAI token to ${parsed.hostname || "an unknown host"}`);
  }
  return url;
}

function parseTokenResponse(payload, previousRefresh = "", now = Date.now()) {
  const access = typeof payload?.access_token === "string" ? payload.access_token : "";
  const refresh = typeof payload?.refresh_token === "string" && payload.refresh_token
    ? payload.refresh_token
    : previousRefresh;
  if (!access) throw new XaiAuthError("xAI token response had no access_token");
  if (!refresh) throw new XaiAuthError("xAI token response had no refresh_token");
  const lifetimeMs = Math.max(MIN_LIFETIME_MS, Number(payload?.expires_in || 0) * 1000);
  return { access, refresh, expiresAt: now + lifetimeMs, obtainedAt: now };
}

async function form(fetchImpl, url, fields) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

/**
 * Runs the RFC 8628 device flow. `print` receives the user-facing lines so the
 * caller can show them in the Bot terminal; nothing secret is ever printed.
 */
export async function deviceLogin(config, {
  fetchImpl = fetch,
  print = (line) => process.stdout.write(`${line}\n`),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  maxWaitMs = 15 * 60_000,
} = {}) {
  const { response, payload } = await form(fetchImpl, DEVICE_CODE_URL, {
    client_id: XAI_OAUTH_CLIENT_ID,
    scope: XAI_OAUTH_SCOPE,
  });
  if (!response.ok) throw new XaiAuthError(`xAI device-code request failed (${response.status})`);
  const deviceCode = typeof payload?.device_code === "string" ? payload.device_code : "";
  const userCode = typeof payload?.user_code === "string" ? payload.user_code : "";
  const verificationUri = typeof payload?.verification_uri_complete === "string"
    ? payload.verification_uri_complete
    : typeof payload?.verification_uri === "string" ? payload.verification_uri : "";
  if (!deviceCode || !userCode || !verificationUri) {
    throw new XaiAuthError("xAI device-code response was missing required fields");
  }
  let intervalMs = Math.max(1, Number(payload?.interval) || 5) * 1000;
  print("xAI Grok sign-in");
  print(`1. On any device, open: ${verificationUri}`);
  print(`2. Confirm this code: ${userCode}`);
  print("3. Sign in with the account that has SuperGrok or X Premium+.");
  print("Waiting for approval…");
  const deadline = now() + maxWaitMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    const poll = await form(fetchImpl, TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: XAI_OAUTH_CLIENT_ID,
      device_code: deviceCode,
    });
    if (poll.response.ok && poll.payload?.access_token) {
      const credentials = parseTokenResponse(poll.payload, "", now());
      await saveCredentials(config, credentials);
      print("Signed in to xAI. Send /provider xai in a Grok Bot to use Grok models.");
      return { ok: true };
    }
    const code = typeof poll.payload?.error === "string" ? poll.payload.error : "";
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (code === "expired_token") throw new XaiAuthError("the xAI sign-in code expired; run the sign-in again");
    if (code === "access_denied") throw new XaiAuthError("xAI sign-in was denied");
    throw new XaiAuthError(`xAI sign-in failed (${code || poll.response.status})`);
  }
  throw new XaiAuthError("timed out waiting for xAI sign-in approval");
}

export async function refreshCredentials(config, credentials, fetchImpl = fetch, now = Date.now()) {
  const { response, payload } = await form(fetchImpl, TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: credentials.refresh,
  });
  if (!response.ok || !payload?.access_token) {
    const code = typeof payload?.error === "string" ? payload.error : String(response.status);
    if (code === "invalid_grant" || response.status === 400 || response.status === 401) {
      await saveCredentials(config, { ...credentials, dead: true, deadReason: code }).catch(() => {});
      throw new XaiAuthError("the xAI sign-in is no longer valid; run: grokbot-router auth xai");
    }
    throw new XaiAuthError(`xAI token refresh failed (${code})`);
  }
  const refreshed = parseTokenResponse(payload, credentials.refresh, now);
  await saveCredentials(config, refreshed);
  return refreshed;
}

/** Returns a usable access token, refreshing when it is about to expire. */
export async function accessToken(config, fetchImpl = fetch, { now = Date.now(), forceRefresh = false } = {}) {
  const credentials = await loadCredentials(config);
  if (!credentials) throw new XaiAuthError("xAI is not signed in; run: grokbot-router auth xai");
  if (credentials.dead) throw new XaiAuthError("the xAI sign-in is no longer valid; run: grokbot-router auth xai");
  if (!forceRefresh && Number(credentials.expiresAt || 0) - REFRESH_SKEW_MS > now) return credentials.access;
  return (await refreshCredentials(config, credentials, fetchImpl, now)).access;
}

export async function authStatus(config, now = Date.now()) {
  const credentials = await loadCredentials(config);
  if (!credentials) return "not signed in";
  if (credentials.dead) return "sign-in expired; run grokbot-router auth xai";
  const remainingMinutes = Math.round((Number(credentials.expiresAt || 0) - now) / 60_000);
  return remainingMinutes > 0
    ? `signed in (access token valid for ~${remainingMinutes} min, refresh token stored)`
    : "signed in (access token will refresh on next use)";
}
