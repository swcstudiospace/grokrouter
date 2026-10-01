import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadProviderModels, newestFamilyModel, xaiSubscriptionModelIds } from "../runtime/model-catalog.mjs";
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
    assert.equal(catalog.source, "live");
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
    assert.equal(offline.source, "packaged");
    assert.deepEqual(offline.models.map((model) => model.id), ["grok-4.6", "grok-4.3"]);

    const foreign = await loadProviderModels("xai", { ...config, xaiBaseUrl: "https://evil.example/v1" }, {
      fetchImpl: async () => { throw new Error("must not be reached"); },
    });
    assert.equal(foreign.source, "packaged");
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
  let listOptions;
  const queryFactory = () => ({ prompt, options }) => {
    listOptions = options;
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
    assert.equal(catalog.source, "live");
    assert.deepEqual(catalog.models.map((model) => model.id), [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    assert.equal(catalog.models[0].name, "Claude Opus 5");
    assert.equal(opened, 1);
    assert.equal(closed, 1, "the control-only query is closed");
    assert.equal(iterated, 0, "no turn is billed to list models");
    assert.equal(listOptions.permissionMode, undefined);
    assert.deepEqual(listOptions.settingSources, []);
    assert.deepEqual(listOptions.tools, []);

    const failing = () => () => { throw new Error("claude binary missing"); };
    await rm(join(root, "catalog.anthropic.json"), { force: true });
    const fallback = await loadProviderModels("anthropic", config, { anthropicQueryFactory: failing });
    assert.equal(fallback.source, "packaged");
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

const level = (effort) => ({ effort, description: effort });
const codexCatalog = (models) => JSON.stringify({ models });
const codexRow = (slug, visibility, priority, extra = {}) => ({
  slug,
  display_name: slug.toUpperCase(),
  visibility,
  priority,
  context_window: 272000,
  default_reasoning_level: "medium",
  supported_reasoning_levels: [level("low"), level("medium"), level("xhigh")],
  ...extra,
});
const accountCatalog = codexCatalog([
  codexRow("gpt-5.5", "list", 7),
  codexRow("gpt-5.6-sol", "list", 1, { supported_reasoning_levels: [level("low"), level("ultra"), level("bad level")] }),
  codexRow("gpt-daybreak-blue-latest", "hide", 3),
  codexRow("gpt-7-nova; rm -rf ~", "list", 2),
  codexRow("gpt-6-astra", "list", 4),
]);
const bundledCatalog = codexCatalog([codexRow("gpt-5.6-sol", "list", 1), codexRow("gpt-5.2", "list", 29)]);

function codexExecStub(responses) {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    const response = responses[args.includes("--bundled") ? "bundled" : "account"];
    if (response instanceof Error) throw response;
    return { stdout: response, stderr: "WARNING: noise on stderr" };
  };
  return { exec, calls };
}

async function codexRoot() {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-codex-models-"));
  return {
    root,
    config: {
      modelCatalogPath: join(root, "catalog"),
      codexPathOverride: "/opt/grokrouter/node_modules/.bin/codex",
      codexModels: ["gpt-5.6-sol", "gpt-6-astra-pro"],
    },
  };
}

test("Codex discovery lists only visible, valid account models and caches them", async () => {
  const { root, config } = await codexRoot();
  const { exec, calls } = codexExecStub({ account: accountCatalog, bundled: new Error("must not need bundled") });
  try {
    const catalog = await loadProviderModels("codex", config, { codexExec: exec });
    assert.equal(catalog.source, "live");
    assert.deepEqual(catalog.models.map((model) => model.id), ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.5"],
      "priority order; hidden and shell-unsafe slugs are dropped");
    const sol = catalog.models[0];
    assert.equal(sol.name, "GPT-5.6-SOL");
    assert.deepEqual(sol.reasoningLevels, ["low", "ultra"]);
    assert.equal(sol.defaultReasoning, "medium");
    assert.equal(sol.contextLength, 272000);
    assert.deepEqual(calls[0].args, ["debug", "models"]);
    assert.equal(calls[0].file, config.codexPathOverride);
    assert.equal(calls[0].options.timeout, 20_000);
    assert.ok(calls[0].options.maxBuffer > 0 && calls[0].options.maxBuffer <= 64 * 1024 * 1024);
    assert.equal(calls[0].options.shell, undefined, "the CLI never runs through a shell");

    const cached = await loadProviderModels("codex", config, { codexExec: exec });
    assert.equal(cached.source, "cache");
    assert.equal(calls.length, 1, "a fresh catalog is reused for an hour");
    const onDisk = JSON.parse(await readFile(`${config.modelCatalogPath}.codex.json`, "utf8"));
    assert.deepEqual(onDisk.models.map((model) => model.id), ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.5"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex discovery falls back to the bundled catalog without caching it", async () => {
  const { root, config } = await codexRoot();
  const { exec, calls } = codexExecStub({ account: new Error("refresh timed out"), bundled: bundledCatalog });
  try {
    const catalog = await loadProviderModels("codex", config, { codexExec: exec });
    assert.equal(catalog.source, "bundled");
    assert.equal(catalog.error, "refresh timed out");
    assert.deepEqual(catalog.models.map((model) => model.id), ["gpt-5.6-sol", "gpt-5.2"]);
    assert.deepEqual(calls.map((call) => call.args), [["debug", "models"], ["debug", "models", "--bundled"]]);

    await loadProviderModels("codex", config, { codexExec: exec });
    assert.equal(calls.length, 4, "the next listing retries the account refresh");
    const offline = await loadProviderModels("codex", config, { codexExec: exec }, { cacheOnly: true });
    assert.equal(offline.source, "packaged", "a bundled list is never cached");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex discovery falls back to the stale cache, then the packaged list", async () => {
  const { root, config } = await codexRoot();
  try {
    const good = codexExecStub({ account: accountCatalog, bundled: bundledCatalog });
    await loadProviderModels("codex", config, { codexExec: good.exec });

    const malformed = codexExecStub({ account: "{not json", bundled: "[]" });
    const fromCache = await loadProviderModels("codex", config, { codexExec: malformed.exec }, {
      now: Date.now() + 2 * 60 * 60_000,
    });
    assert.equal(fromCache.source, "cache");
    assert.equal(fromCache.stale, true);
    assert.match(fromCache.error, /not valid JSON/);
    assert.deepEqual(fromCache.models.map((model) => model.id), ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.5"]);

    await rm(`${config.modelCatalogPath}.codex.json`);
    const oversized = codexExecStub({
      account: codexCatalog([codexRow("gpt-5.6-sol", "list", 1, { base_instructions: "x".repeat(17 * 1024 * 1024) })]),
      bundled: codexCatalog([codexRow("gpt-5.6-sol", "hide", 1)]),
    });
    const packaged = await loadProviderModels("codex", config, { codexExec: oversized.exec });
    assert.equal(packaged.source, "packaged");
    assert.match(packaged.error, /size limit/);
    assert.deepEqual(packaged.models.map((model) => model.id), ["gpt-5.6-sol", "gpt-6-astra-pro"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog IDs that are not plain model IDs are dropped from every source", async () => {
  const { root, config } = await codexRoot();
  try {
    await writeFile(`${config.modelCatalogPath}.xai.json`, JSON.stringify({
      fetchedAt: Date.now(),
      models: [{ id: "grok-4.7" }, { id: "grok 4.7 && curl evil" }, { id: "$(reboot)" }],
    }));
    const cached = await loadProviderModels("xai", config, {}, { cacheOnly: true });
    assert.deepEqual(cached.models.map((model) => model.id), ["grok-4.7"]);

    const packaged = await loadProviderModels("anthropic", { ...config, anthropicModels: ["claude-opus-5", "bad`id"] }, {}, {
      cacheOnly: true,
    });
    assert.deepEqual(packaged.models.map((model) => model.id), ["claude-opus-5"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("family aliases pick the newest plain release in their namespace", () => {
  const ids = (...list) => list.map((id) => ({ id }));
  const openrouter = ids(
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet-5.5:batch",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-sonnet-5",
    "~anthropic/claude-sonnet-latest",
    "anthropic/claude-opus-4.8",
    "openai/gpt-6-sol-pro",
    "openai/gpt-6-sol",
    "openai/gpt-5.6-sol",
    "x-ai/grok-4.20",
    "x-ai/grok-4.7",
    "x-ai/grok-4.20-multi-agent",
  );
  assert.equal(newestFamilyModel("openrouter", "sonnet", openrouter), "anthropic/claude-sonnet-5.5");
  assert.equal(newestFamilyModel("openrouter", "Claude", openrouter), "anthropic/claude-sonnet-5.5");
  assert.equal(newestFamilyModel("openrouter", "sol", openrouter), "openai/gpt-6-sol");
  assert.equal(newestFamilyModel("openrouter", "grok", openrouter), "x-ai/grok-4.7", "4.20 is older than 4.7");
  assert.equal(newestFamilyModel("openrouter", "haiku", openrouter), null);
  assert.equal(newestFamilyModel("anthropic", "sonnet", openrouter), null, "namespaces do not cross providers");

  const anthropic = ids("claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-haiku-4-6-20260101", "claude-haiku-4");
  assert.equal(newestFamilyModel("anthropic", "haiku", anthropic), "claude-haiku-4-6-20260101");
  assert.equal(newestFamilyModel("anthropic", "haiku", ids("claude-haiku-4-5-20251001", "claude-haiku-4-5")),
    "claude-haiku-4-5", "the undated alias tracks its snapshots");
  assert.equal(newestFamilyModel("codex", "luna", ids("gpt-5.6-luna", "gpt-6-luna", "gpt-6-luna-pro")), "gpt-6-luna");
  assert.equal(newestFamilyModel("xai", "grok", ids("grok-4.6", "grok-4.20", "grok-build-0.1")), "grok-4.6");
});

test("/model family aliases resolve from the cached catalog and never reach inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-alias-controls-"));
  const config = {
    provider: "openrouter",
    providers: ["codex", "openrouter"],
    openRouterModel: "anthropic/claude-sonnet-5",
    openRouterCatalogPath: join(root, "openrouter.json"),
    modelCatalogPath: join(root, "catalog"),
    statePath: join(root, "states.json"),
    auditPath: join(root, "audit.jsonl"),
  };
  await writeFile(config.openRouterCatalogPath, JSON.stringify({
    fetchedAt: Date.now(),
    models: ["anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5.5:batch"]
      .map((id) => ({ id, name: id, contextLength: 0, free: false, tools: true })),
  }));
  const neverInfer = async () => { throw new Error("control input leaked to model inference"); };
  const neverSpawn = async () => { throw new Error("a control spawned Codex discovery"); };
  const send = (text, botId = "alias-bot") => runTurn({ config, messages: [user(text)], sessionOptions: { botId } }, {
    fetchImpl: neverInfer,
    catalogFetch: neverInfer,
    codexExec: neverSpawn,
    codexFactory: () => { throw new Error("control input leaked to Codex"); },
  });
  try {
    const sonnet = await send("/model sonnet");
    assert.equal(sonnet.control, true);
    assert.equal(sonnet.model, "anthropic/claude-sonnet-5.5");
    assert.doesNotMatch(sonnet.text, /Note:/);

    const opus = await send("/model opus");
    assert.equal(opus.model, "anthropic/claude-opus-5.5", "no catalog match falls back to the pinned alias");
    assert.match(opus.text, /not in the known OpenRouter model list/);

    await send("/provider codex", "codex-alias-bot");
    const sol = await send("/model sol", "codex-alias-bot");
    assert.equal(sol.control, true);
    assert.equal(sol.model, "gpt-5.6-sol", "an empty Codex catalog uses the pinned alias");
    assert.equal(sol.usage.inputTokens, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/models names the catalog source and audits a discovery failure as a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-codex-listing-"));
  const config = {
    provider: "codex",
    providers: ["codex"],
    codexModel: "gpt-5.6-sol",
    codexModels: ["gpt-5.6-sol"],
    modelCatalogPath: join(root, "catalog"),
    statePath: join(root, "states.json"),
    auditPath: join(root, "audit.jsonl"),
  };
  const { exec } = codexExecStub({ account: new Error("account refresh failed"), bundled: bundledCatalog });
  const send = (text) => runTurn({ config, messages: [user(text)], sessionOptions: { botId: "codex-list-bot" } }, {
    codexExec: exec,
    codexFactory: () => { throw new Error("control input leaked to Codex"); },
  });
  try {
    const listed = await send("/models");
    assert.match(listed.text, /^Codex SDK models:\nShowing 2 of 2/);
    assert.match(listed.text, /gpt-5\.2 — tools, 272k ctx, reasoning low\/medium\/xhigh/);
    assert.match(listed.text, /Catalog: Codex CLI bundled list; Codex SDK could not be refreshed\./);
    assert.equal(listed.catalogWarning, undefined, "the warning stays in the audit");
    const audit = (await readFile(config.auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(audit.at(-1).event, "control_turn");
    assert.equal(audit.at(-1).catalogWarning, "account refresh failed");

    const doctor = await send("/router doctor");
    assert.match(doctor.text, /Model catalogs: Codex SDK packaged list \(1\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
