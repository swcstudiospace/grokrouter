import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyProviderError,
  formatFailures,
  recentFailures,
  runOpenRouter,
  runTurn,
  runXai,
} from "../runtime/run-provider.mjs";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const json = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), { status, headers });

test("provider failures are classified into an actionable code and hint", () => {
  const cases = [
    [new Error("xAI request failed (401: expired token)"), "xai", "auth"],
    [new Error("xAI request failed (429: rate limit exceeded)"), "xai", "rate-limit"],
    [new Error("OpenRouter request failed (404: No endpoints found for vendor/model)"), "openrouter", "model-not-found"],
    [new Error("OpenRouter request failed (400: context_length_exceeded)"), "openrouter", "context-length"],
    [new Error("The operation was aborted due to timeout"), "xai", "timeout"],
    [new Error("OpenRouter returned an empty response after one retry"), "openrouter", "empty-response"],
    [new Error("xAI request failed (503: upstream unavailable)"), "xai", "provider-unavailable"],
    [new Error("fetch failed"), "openrouter", "provider-unavailable"],
    [new Error("xAI request failed (400: unsupported parameter)"), "xai", "bad-request"],
    [new Error("spawn /usr/bin/node ENOENT"), "codex", "runtime"],
    [new Error("something nobody predicted"), "codex", "unknown"],
    [new Error("xAI is not signed in; run: grokbot-router auth xai"), "xai", "auth"],
  ];
  for (const [error, provider, code] of cases) {
    const classified = classifyProviderError(error, provider);
    assert.equal(classified.code, code, error.message);
    assert.ok(classified.hint.length > 10, `hint for ${code}`);
  }
  assert.match(classifyProviderError(new Error("bad"), "xai").hint, /grokbot-router errors/);
  assert.match(classifyProviderError({ message: "nope", status: 401 }, "anthropic").hint, /grokbot-router auth anthropic/);
});

test("a failed turn records its code and hint, and doctor reports the history", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-diagnostics-"));
  const config = {
    provider: "openrouter",
    providers: ["openrouter"],
    openRouterModel: "openai/test-model",
    openRouterModels: ["openai/test-model"],
    openRouterCatalogPath: join(root, "catalog.json"),
    statePath: join(root, "states.json"),
    auditPath: join(root, "audit.jsonl"),
    sleepImpl: async () => {},
  };
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = ["sk", "or", "v1", "syntheticfixture0000000000000000"].join("-");
  try {
    await assert.rejects(runTurn({
      config,
      messages: [user("hello")],
      sessionOptions: { botId: "failure-bot" },
    }, {
      fetchImpl: async () => json({ error: { message: "rate limit exceeded" } }, 429, { "retry-after": "0" }),
      catalogFetch: async () => { throw new Error("offline"); },
    }), /rate limit/);

    const audit = (await readFile(config.auditPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const failure = audit.find((event) => event.event === "turn_error");
    assert.equal(failure.errorCode, "rate-limit");
    assert.match(failure.hint, /Wait, or switch/);
    assert.equal(failure.error.includes("syntheticfixture"), false, "credentials never reach the audit");

    const failures = await recentFailures(config, 3);
    assert.equal(failures.available, true);
    assert.equal(failures.total, 1);
    assert.equal(failures.last24h, 1);
    assert.equal(failures.entries[0].code, "rate-limit");
    assert.match(formatFailures(failures), /Recent failures: 1 recorded, 1 in the last 24 hours/);

    const doctor = await runTurn({
      config,
      messages: [user("/router doctor")],
      sessionOptions: { botId: "failure-bot" },
    });
    assert.match(doctor.text, /Recent failures: 1 recorded/);
    assert.match(doctor.text, /\[rate-limit\]/);

    const empty = await recentFailures({ auditPath: join(root, "missing.jsonl") });
    assert.equal(empty.available, false);
    assert.match(formatFailures(empty), /no audit log yet/);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a rate limit or provider blip is retried once before the turn fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-retry-"));
  const config = {
    xaiModel: "grok-4.6",
    xaiCredentialsPath: join(root, "xai-oauth.json"),
    modelCatalogPath: join(root, "catalog"),
    sleepImpl: async () => {},
  };
  await writeFile(config.xaiCredentialsPath, JSON.stringify({
    access: "token-1",
    refresh: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
  }));
  try {
    let attempts = 0;
    const recovered = await runXai(config, [user("hi")], [], async () => {
      attempts += 1;
      if (attempts === 1) return json({ error: { message: "too many requests" } }, 429, { "retry-after": "1" });
      return json({ choices: [{ message: { content: "RECOVERED" } }] });
    });
    assert.equal(recovered.text, "RECOVERED");
    assert.equal(attempts, 2);

    let persistent = 0;
    await assert.rejects(runXai(config, [user("hi")], [], async () => {
      persistent += 1;
      return json({ error: { message: "still limited" } }, 429);
    }), /xAI request failed \(429/);
    assert.equal(persistent, 2, "exactly one retry, never a loop");

    let serverErrors = 0;
    await assert.rejects(runXai(config, [user("hi")], [], async () => {
      serverErrors += 1;
      return json({ error: { message: "upstream" } }, 503);
    }), /503/);
    assert.equal(serverErrors, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected request shape is retried once without the optional fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-shape-"));
  const config = {
    xaiModel: "grok-4.6",
    xaiCredentialsPath: join(root, "xai-oauth.json"),
    modelCatalogPath: join(root, "catalog"),
    sleepImpl: async () => {},
  };
  await writeFile(config.xaiCredentialsPath, JSON.stringify({
    access: "token-1",
    refresh: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
  }));
  try {
    const bodies = [];
    const result = await runXai(config, [user("hi")], [], async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ("reasoning_effort" in body) {
        return json({ error: { message: "unsupported parameter: reasoning_effort" } }, 400);
      }
      return json({ choices: [{ message: { content: "PLAIN_OK" } }] });
    });
    assert.equal(result.text, "PLAIN_OK");
    assert.equal(bodies.length, 2);
    assert.equal("reasoning_effort" in bodies[1], false);
    assert.equal(bodies[1].model, "grok-4.6");

    // A 400 that is not about the request shape must not burn a second call.
    let contextCalls = 0;
    await assert.rejects(runXai(config, [user("hi")], [], async () => {
      contextCalls += 1;
      return json({ error: { message: "context_length_exceeded" } }, 400);
    }), /400/);
    assert.equal(contextCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a model with no tool support is never sent tool schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-tools-"));
  const catalogPath = join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({
    fetchedAt: Date.now(),
    models: [{ id: "vendor/no-tools:free", name: "No Tools", free: true, tools: false, contextLength: 8192 }],
  }));
  const config = {
    openRouterModel: "vendor/no-tools:free",
    openRouterCatalogPath: catalogPath,
    sleepImpl: async () => {},
  };
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = ["sk", "or", "v1", "syntheticfixture0000000000000000"].join("-");
  try {
    let body;
    const result = await runOpenRouter(
      config,
      [user("use my computer")],
      [{ name: "Shell", inputSchema: { type: "object" } }],
      async (url, init) => {
        body = JSON.parse(init.body);
        return json({ choices: [{ message: { content: "ANSWERED" } }] });
      },
    );
    assert.equal(result.text, "ANSWERED");
    assert.equal(body.tools, undefined, "no tool schemas are offered");
    assert.equal(body.tool_choice, undefined);
    assert.equal(result.toolSupportDowngrade, true);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});
