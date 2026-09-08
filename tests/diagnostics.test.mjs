import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyProviderError,
  formatFailures,
  probeXai,
  recentFailures,
  rejectsRequestShape,
  runOpenRouter,
  runTurn,
  runXai,
  unsupportedRequestFields,
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
    providerQuirksPath: join(root, "quirks.json"),
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

    // The rejected field is remembered, so the next turn sends one request.
    const quirks = JSON.parse(await readFile(config.providerQuirksPath, "utf8"));
    assert.deepEqual(quirks["xai:grok-4.6"].unsupported, ["reasoning_effort"]);
    const afterMemory = [];
    const second = await runXai(config, [user("hi")], [], async (url, init) => {
      afterMemory.push(JSON.parse(init.body));
      return json({ choices: [{ message: { content: "REMEMBERED" } }] });
    });
    assert.equal(second.text, "REMEMBERED");
    assert.equal(afterMemory.length, 1, "no repeated failure once the quirk is known");
    assert.equal("reasoning_effort" in afterMemory[0], false);
    assert.deepEqual(second.droppedOptionalKeys, ["reasoning_effort"]);

    // A 400 that is not about the request shape must not burn a second call.
    let contextCalls = 0;
    await assert.rejects(runXai({ ...config, providerQuirksPath: join(root, "other.json") }, [user("hi")], [], async () => {
      contextCalls += 1;
      return json({ error: { message: "context_length_exceeded" } }, 400);
    }), /400/);
    assert.equal(contextCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("xAI's camelCase rejection names the field it refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-camel-"));
  const config = {
    xaiModel: "grok-4.20-0309-reasoning",
    xaiCredentialsPath: join(root, "xai-oauth.json"),
    providerQuirksPath: join(root, "quirks.json"),
    sleepImpl: async () => {},
  };
  await writeFile(config.xaiCredentialsPath, JSON.stringify({
    access: "token-1",
    refresh: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
  }));
  try {
    assert.deepEqual(
      unsupportedRequestFields(
        "Model grok-4.20-0309-reasoning does not support parameter reasoningEffort",
        { reasoning_effort: "high", parallel_tool_calls: false },
      ),
      ["reasoning_effort"],
      "camelCase in prose still names the snake_case field we sent",
    );
    assert.equal(rejectsRequestShape("Model X does not support parameter reasoningEffort"), true);

    const sent = [];
    const result = await runXai(config, [user("hi")], [], async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      if ("reasoning_effort" in body) {
        return json({
          error: { message: `Model ${body.model} does not support parameter reasoningEffort` },
        }, 400);
      }
      return json({ choices: [{ message: { content: "GROK_OK" } }] });
    });
    assert.equal(result.text, "GROK_OK");
    assert.equal(sent.length, 2);
    assert.deepEqual(result.droppedOptionalKeys, ["reasoning_effort"]);
    const quirks = JSON.parse(await readFile(config.providerQuirksPath, "utf8"));
    assert.deepEqual(quirks["xai:grok-4.20-0309-reasoning"].unsupported, ["reasoning_effort"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bad-request hint repeats what the provider actually said", () => {
  const classified = classifyProviderError(
    new Error("xAI request failed (400: Model grok-4.6 does not support parameter reasoningEffort)"),
    "xai",
  );
  assert.equal(classified.code, "bad-request");
  assert.match(classified.hint, /xAI said: Model grok-4.6 does not support parameter reasoningEffort/);
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

test("the xAI probe reports which request shapes the account accepts", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-probe-"));
  const config = {
    xaiModel: "grok-4.6",
    xaiCredentialsPath: join(root, "xai-oauth.json"),
  };
  await writeFile(config.xaiCredentialsPath, JSON.stringify({
    access: "token-secret",
    refresh: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
  }));
  const lines = [];
  try {
    const report = await probeXai(config, async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.startsWith("https://cli-chat-proxy.grok.com")) return json({ error: { message: "not enabled" } }, 403);
      if ("reasoning_effort" in body) {
        return json({ error: { message: `Model ${body.model} does not support parameter reasoningEffort` } }, 400);
      }
      return json({ choices: [{ message: { content: "pong" } }] });
    }, (line) => lines.push(line));

    assert.equal(report.ok, true);
    const output = lines.join("\n");
    assert.match(output, /PASS public API · minimal · HTTP 200/);
    assert.match(output, /FAIL public API · reasoning_effort · HTTP 400 · Model grok-4.6 does not support parameter reasoningEffort/);
    assert.match(output, /FAIL subscription proxy · minimal · HTTP 403/);
    assert.match(output, /Accepted shapes: public API\/minimal/);
    assert.equal(output.includes("token-secret"), false, "the probe never prints the token");

    const signedOut = await probeXai({ xaiCredentialsPath: join(root, "missing.json") }, async () => json({}), (line) => lines.push(line));
    assert.equal(signedOut.ok, false);
    assert.match(lines.at(-1), /xAI probe cannot run: xAI is not signed in/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
