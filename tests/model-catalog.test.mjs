import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadProviderModels, xaiSubscriptionModelIds } from "../runtime/model-catalog.mjs";
import { runTurn, runXai } from "../runtime/run-provider.mjs";

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });

async function xaiConfig(root) {
  const config = {
    xaiCredentialsPath: join(root, "xai-oauth.json"),
    modelCatalogPath: join(root, "catalog"),
  };
  await writeFile(config.xaiCredentialsPath, JSON.stringify({
    access: "token-1",
    refresh: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
  }));
  return config;
}

test("xAI discovery merges the metered and subscription catalogs and flags quota models", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-xai-models-"));
  const config = await xaiConfig(root);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    if (url.startsWith("https://cli-chat-proxy.grok.com")) {
      return json({ data: [{ id: "grok-4.6" }, { id: "grok-4.5" }] });
    }
    return json({ data: [{ id: "grok-4.6" }, { id: "grok-4.3" }, { id: "grok-build-0.1" }] });
  };
  try {
    const catalog = await loadProviderModels("xai", config, { fetchImpl });
    assert.equal(catalog.source, "provider");
    assert.deepEqual(catalog.models.map((model) => model.id), [
      "grok-4.3",
      "grok-4.5",
      "grok-4.6",
      "grok-build-0.1",
    ]);
    assert.equal(catalog.models.find((model) => model.id === "grok-4.5").subscription, true);
    assert.equal(catalog.models.find((model) => model.id === "grok-4.3").subscription, false);
    assert.deepEqual(seen.map((entry) => entry.auth), ["Bearer token-1", "Bearer token-1"]);
    assert.deepEqual((await xaiSubscriptionModelIds(config)).sort(), ["grok-4.5", "grok-4.6"]);

    // A cached subscription model routes to the quota proxy without config.
    const requested = [];
    await runXai({ ...config, xaiModel: "grok-4.5" }, [user("hi")], [], async (url) => {
      requested.push(url);
      return json({ choices: [{ message: { content: "ok" } }] });
    });
    assert.deepEqual(requested, ["https://cli-chat-proxy.grok.com/v1/chat/completions"]);

    const second = await loadProviderModels("xai", config, { fetchImpl });
    assert.equal(second.source, "cache");
    assert.equal(seen.length, 2, "the catalog is cached for an hour");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("xAI discovery falls back to the packaged list and never leaves an xAI host", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-xai-models-"));
  const config = { ...(await xaiConfig(root)), xaiModels: ["grok-4.6", "grok-4.3"] };
  try {
    const offline = await loadProviderModels("xai", config, {
      fetchImpl: async () => { throw new Error("offline"); },
    });
    assert.equal(offline.source, "configured");
    assert.deepEqual(offline.models.map((model) => model.id), ["grok-4.6", "grok-4.3"]);

    const foreign = await loadProviderModels("xai", { ...config, xaiBaseUrl: "https://evil.example/v1" }, {
      fetchImpl: async () => { throw new Error("must not be reached"); },
    });
    assert.equal(foreign.source, "configured");
    assert.match(String(foreign.error), /refusing to send the xAI token/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Anthropic discovery reads the Agent SDK model list without running a turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-anthropic-models-"));
  const config = { modelCatalogPath: join(root, "catalog"), anthropicModels: ["claude-sonnet-5"] };
  let opened = 0;
  let closed = 0;
  let iterated = 0;
  const queryFactory = () => ({ prompt, options }) => {
    opened += 1;
    return {
      async *[Symbol.asyncIterator]() { iterated += 1; },
      supportedModels: async () => [
        { value: "claude-opus-5", displayName: "Claude Opus 5", description: "Most capable" },
        { value: "claude-sonnet-5", displayName: "Claude Sonnet 5", description: "Balanced" },
        { value: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", description: "Fast" },
      ],
      close: () => { closed += 1; },
    };
  };
  try {
    const catalog = await loadProviderModels("anthropic", config, { anthropicQueryFactory: queryFactory });
    assert.equal(catalog.source, "provider");
    assert.deepEqual(catalog.models.map((model) => model.id), [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    assert.equal(catalog.models[0].name, "Claude Opus 5");
    assert.equal(opened, 1);
    assert.equal(closed, 1, "the control-only query is closed");
    assert.equal(iterated, 0, "no turn is billed to list models");

    const failing = () => () => { throw new Error("claude binary missing"); };
    await rm(join(root, "catalog.anthropic.json"), { force: true });
    const fallback = await loadProviderModels("anthropic", config, { anthropicQueryFactory: failing });
    assert.equal(fallback.source, "configured");
    assert.deepEqual(fallback.models.map((model) => model.id), ["claude-sonnet-5"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/models lists every live model for a non-OpenRouter provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-models-control-"));
  const config = {
    provider: "xai",
    providers: ["xai"],
    xaiModel: "grok-4.6",
    xaiModels: ["grok-4.6"],
    xaiCredentialsPath: join(root, "xai-oauth.json"),
    modelCatalogPath: join(root, "catalog"),
    statePath: join(root, "states.json"),
    auditPath: join(root, "audit.jsonl"),
  };
  await writeFile(config.xaiCredentialsPath, JSON.stringify({
    access: "token-1",
    refresh: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
  }));
  const fetchImpl = async (url) => url.startsWith("https://cli-chat-proxy.grok.com")
    ? json({ data: [{ id: "grok-4.6" }] })
    : json({ data: [{ id: "grok-4.6" }, { id: "grok-4.5" }, { id: "grok-4.20-multi-agent" }] });
  const send = (text) => runTurn({ config, messages: [user(text)], sessionOptions: { botId: "xai-models-bot" } }, { catalogFetch: fetchImpl });
  try {
    const listed = await send("/models");
    assert.match(listed.text, /^xAI models:\nShowing 3 of 3 \(page 1\/1\)\./);
    assert.match(listed.text, /grok-4.20-multi-agent/);
    assert.match(listed.text, /Current: grok-4.6/);
    assert.doesNotMatch(listed.text, /\/models free/);

    const search = await send("/models search multi");
    assert.match(search.text, /xAI models matching “multi”/);
    assert.match(search.text, /grok-4.20-multi-agent/);

    const free = await send("/models free");
    assert.match(free.text, /Free models are an OpenRouter feature/);

    const switched = await send("/model grok-4.5");
    assert.equal(switched.model, "grok-4.5");
    assert.doesNotMatch(switched.text, /Note:/);

    const unknown = await send("/model grok-9");
    assert.equal(unknown.model, "grok-9");
    assert.match(unknown.text, /not in the known xAI model list/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
