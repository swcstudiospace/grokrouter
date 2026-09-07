import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  XAI_OAUTH_CLIENT_ID,
  accessToken,
  assertBearerOrigin,
  authStatus,
  deviceLogin,
  loadCredentials,
  saveCredentials,
} from "../runtime/xai-oauth.mjs";

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test("device login prints the verification code, honors slow_down, and stores tokens privately", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-xai-"));
  const config = { xaiCredentialsPath: join(root, "nested", "xai-oauth.json") };
  const requests = [];
  const printed = [];
  const sleeps = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    requests.push({ url, body });
    if (url.endsWith("/oauth2/device/code")) {
      return json({
        device_code: "dev-secret",
        user_code: "ABCD-1234",
        verification_uri: "https://auth.x.ai/activate",
        verification_uri_complete: "https://auth.x.ai/activate?user_code=ABCD-1234",
        interval: 2,
        expires_in: 600,
      });
    }
    polls += 1;
    if (polls === 1) return json({ error: "authorization_pending" }, 400);
    if (polls === 2) return json({ error: "slow_down" }, 400);
    return json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 });
  };
  try {
    const result = await deviceLogin(config, {
      fetchImpl,
      print: (line) => printed.push(line),
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => 1_000_000,
    });
    assert.equal(result.ok, true);
    assert.equal(requests[0].body.client_id, XAI_OAUTH_CLIENT_ID);
    assert.match(requests[0].body.scope, /offline_access/);
    assert.equal(requests[1].body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(requests[1].body.device_code, "dev-secret");
    assert.deepEqual(sleeps, [2000, 2000, 7000]);
    assert.ok(printed.some((line) => line.includes("ABCD-1234")));
    assert.ok(printed.some((line) => line.includes("https://auth.x.ai/activate?user_code=ABCD-1234")));
    assert.equal(printed.join("\n").includes("access-secret"), false);
    const stored = await loadCredentials(config);
    assert.equal(stored.access, "access-secret");
    assert.equal(stored.expiresAt, 1_000_000 + 3_600_000);
    const mode = (await stat(config.xaiCredentialsPath)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device login surfaces denial and expiry as clear errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-xai-"));
  const config = { xaiCredentialsPath: join(root, "xai-oauth.json") };
  const make = (error) => async (url) => url.endsWith("/device/code")
    ? json({ device_code: "d", user_code: "U", verification_uri: "https://auth.x.ai/activate", interval: 1 })
    : json({ error }, 400);
  const options = { print: () => {}, sleep: async () => {}, now: () => 0 };
  try {
    await assert.rejects(deviceLogin(config, { ...options, fetchImpl: make("access_denied") }), /denied/);
    await assert.rejects(deviceLogin(config, { ...options, fetchImpl: make("expired_token") }), /expired/);
    assert.equal(await loadCredentials(config), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("access token refreshes near expiry and quarantines a revoked refresh token", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-xai-"));
  const config = { xaiCredentialsPath: join(root, "xai-oauth.json") };
  try {
    await assert.rejects(accessToken(config), /not signed in/);
    await saveCredentials(config, { access: "old", refresh: "r1", expiresAt: 10_000_000 });
    assert.equal(await accessToken(config, async () => { throw new Error("unexpected"); }, { now: 1_000 }), "old");
    let refreshBody;
    const refreshing = async (url, init) => {
      refreshBody = Object.fromEntries(new URLSearchParams(init.body));
      return json({ access_token: "new", expires_in: 1800 });
    };
    assert.equal(await accessToken(config, refreshing, { now: 9_990_000 }), "new");
    assert.equal(refreshBody.grant_type, "refresh_token");
    assert.equal(refreshBody.refresh_token, "r1");
    const stored = JSON.parse(await readFile(config.xaiCredentialsPath, "utf8"));
    assert.equal(stored.refresh, "r1");
    assert.equal(stored.expiresAt, 9_990_000 + 1_800_000);
    assert.match(await authStatus(config, 9_990_000), /signed in/);

    const revoked = async () => json({ error: "invalid_grant" }, 400);
    await assert.rejects(accessToken(config, revoked, { now: stored.expiresAt }), /grokbot-router auth xai/);
    await assert.rejects(accessToken(config, async () => json({ access_token: "x" })), /no longer valid/);
    assert.match(await authStatus(config), /expired/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bearer token may only travel to xAI hosts over https", () => {
  assert.equal(assertBearerOrigin("https://api.x.ai/v1/chat/completions"), "https://api.x.ai/v1/chat/completions");
  assert.equal(assertBearerOrigin("https://cli-chat-proxy.grok.com/v1/models"), "https://cli-chat-proxy.grok.com/v1/models");
  assert.throws(() => assertBearerOrigin("https://evil.example/v1/chat/completions"), /refusing/);
  assert.throws(() => assertBearerOrigin("http://api.x.ai/v1/chat/completions"), /refusing/);
  assert.throws(() => assertBearerOrigin("not a url"), /refusing/);
});
