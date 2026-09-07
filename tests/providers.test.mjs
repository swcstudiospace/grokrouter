import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PROVIDER_IDS, runAnthropic, runTurn, runXai } from "../runtime/run-provider.mjs";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const catalogPayload = {
  data: [
    { id: "openai/gpt-6-astra", name: "OpenAI: GPT-6 Astra", context_length: 1050000, pricing: { prompt: "0.00001", completion: "0.00005" }, supported_parameters: ["tools"] },
    { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)", context_length: 131072, pricing: { prompt: "0", completion: "0" }, supported_parameters: [] },
    { id: "minimax/minimax-m3:free", name: "MiniMax M3 (free)", context_length: 200000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
  ],
};

test("the provider table lists all four providers", () => {
  assert.deepEqual(PROVIDER_IDS, ["codex", "openrouter", "anthropic", "xai"]);
});

test("OpenRouter model commands browse the live catalog and warn about unlisted or tool-less models", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-catalog-controls-"));
  const config = {
    provider: "openrouter",
    providers: ["openrouter"],
    openRouterModel: "openai/gpt-6-astra",
    openRouterModels: ["openai/gpt-6-astra"],
    openRouterCatalogPath: join(root, "catalog.json"),
    statePath: join(root, "states.json"),
    auditPath: join(root, "audit.jsonl"),
  };
  let catalogRequests = 0;
  const catalogFetch = async (url) => {
    catalogRequests += 1;
    assert.equal(url, "https://openrouter.ai/api/v1/models");
    return json(catalogPayload);
  };
  const send = (text) => runTurn({ config, messages: [user(text)], sessionOptions: { botId: "catalog-bot" } }, {
    catalogFetch,
    fetchImpl: async () => { throw new Error("control reached inference"); },
  });
  try {
    const listed = await send("/models");
    assert.match(listed.text, /^OpenRouter models:\nShowing 3 of 3 \(page 1\/1\)\./);
    assert.match(listed.text, /minimax\/minimax-m3:free/);
    assert.match(listed.text, /\/models free/);
    assert.equal(catalogRequests, 1, "a bare /models uses the live catalog");

    const free = await send("/models free");
    assert.match(free.text, /^Free OpenRouter models:\nShowing 2 of 2 \(page 1\/1\)\./);
    assert.match(free.text, /• google\/gemma-4-31b-it:free — free, no tools, 131k ctx/);
    assert.match(free.text, /• minimax\/minimax-m3:free — free, tools, 200k ctx/);
    assert.doesNotMatch(free.text.split("Current:")[0], /gpt-6-astra/, "paid models stay out of the free listing");
    assert.equal(catalogRequests, 1);

    const all = await send("/models all");
    assert.match(all.text, /^OpenRouter models:\nShowing 3 of 3/);
    assert.equal(catalogRequests, 1, "the catalog is cached between controls");

    const refreshed = await send("/models refresh");
    assert.match(refreshed.text, /OpenRouter models:/);
    assert.equal(catalogRequests, 2, "/models refresh bypasses the cache");

    const search = await send("/models search gemma");
    assert.match(search.text, /matching “gemma”/);
    assert.match(search.text, /gemma-4-31b-it:free/);
    assert.doesNotMatch(search.text, /minimax/);
    const missing = await send("/models search nothing-here");
    assert.match(missing.text, /No OpenRouter model matches/);

    const toolLess = await send("/model google/gemma-4-31b-it:free");
    assert.equal(toolLess.model, "google/gemma-4-31b-it:free");
    assert.match(toolLess.text, /does not advertise native tool calling/);

    const unlisted = await send("/model vendor/brand-new-model");
    assert.equal(unlisted.model, "vendor/brand-new-model");
    assert.match(unlisted.text, /not in the known OpenRouter model list/);

    const alias = await send("/model free");
    assert.equal(alias.model, "openrouter/free");

    const known = await send("/model minimax/minimax-m3:free");
    assert.doesNotMatch(known.text, /Note:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog outages degrade to a clear message without breaking controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-catalog-outage-"));
  const config = {
    provider: "openrouter",
    providers: ["openrouter"],
    openRouterCatalogPath: join(root, "catalog.json"),
    statePath: join(root, "states.json"),
    auditPath: join(root, "audit.jsonl"),
  };
  try {
    const offline = await runTurn({ config, messages: [user("/models free")], sessionOptions: { botId: "outage-bot" } }, {
      catalogFetch: async () => { throw new Error("offline"); },
    });
    assert.match(offline.text, /the live list is unavailable right now/);
    const switched = await runTurn({ config, messages: [user("/model vendor/some-model")], sessionOptions: { botId: "outage-bot" } }, {
      catalogFetch: async () => { throw new Error("offline"); },
    });
    assert.equal(switched.model, "vendor/some-model");
    assert.doesNotMatch(switched.text, /Note:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bots can switch to the Anthropic and xAI providers with their own defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-new-providers-"));
  const config = {
    provider: "codex",
    providers: ["codex", "openrouter", "anthropic", "xai"],
    anthropicModel: "claude-sonnet-5",
    anthropicModels: ["claude-opus-5", "claude-sonnet-5"],
    xaiModel: "grok-4.6",
    xaiModels: ["grok-4.6", "grok-build-0.1"],
    xaiReasoning: "high",
    xaiCredentialsPath: join(root, "xai-oauth.json"),
    statePath: join(root, "states.json"),
    auditPath: join(root, "audit.jsonl"),
  };
  const send = (text) => runTurn({ config, messages: [user(text)], sessionOptions: { botId: "switch-bot" } });
  try {
    const anthropic = await send("/provider anthropic");
    assert.equal(anthropic.provider, "anthropic");
    assert.equal(anthropic.model, "claude-sonnet-5");
    assert.match(anthropic.text, /to Anthropic \(claude-sonnet-5\)/);
    const models = await send("/models");
    assert.match(models.text, /Anthropic models:/);
    assert.match(models.text, /claude-opus-5/);
    assert.doesNotMatch(models.text, /\/models free/);
    const opus = await send("/model opus");
    assert.equal(opus.model, "claude-opus-5");
    const bad = await send("/model not valid!");
    assert.match(bad.text, /Invalid Anthropic model ID/);

    const xai = await send("/provider xai");
    assert.equal(xai.provider, "xai");
    assert.equal(xai.model, "grok-4.6");
    const status = await send("/provider");
    assert.match(status.text, /xAI is active for this bot\. Model: grok-4.6\. Reasoning: high\./);
    const doctor = await send("/router doctor");
    assert.match(doctor.text, /xAI credential: not signed in/);

    const disabled = await runTurn({
      config: { ...config, providers: ["codex"] },
      messages: [user("/provider xai")],
      sessionOptions: { botId: "locked-bot" },
    });
    assert.match(disabled.text, /not enabled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("xAI sends the OAuth bearer only to api.x.ai, refreshes once on 401, and maps reasoning", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-xai-run-"));
  const config = {
    xaiModel: "grok-4.6",
    xaiReasoning: "xhigh",
    xaiCredentialsPath: join(root, "xai-oauth.json"),
    adapterSessionId: "session-1",
  };
  await writeFile(config.xaiCredentialsPath, JSON.stringify({ access: "stale-token", refresh: "refresh-1", expiresAt: Date.now() + 3_600_000 }));
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url === "https://auth.x.ai/oauth2/token") {
      return json({ access_token: "fresh-token", refresh_token: "refresh-2", expires_in: 3600 });
    }
    assert.equal(url, "https://api.x.ai/v1/chat/completions");
    if (init.headers.Authorization === "Bearer stale-token") return json({ error: { message: "expired" } }, 401);
    return json({ model: "grok-4.6", choices: [{ message: { content: "GROK_OK", tool_calls: [] } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
  };
  try {
    const result = await runXai(config, [user("Reply with exactly GROK_OK")], [], fetchImpl);
    assert.equal(result.text, "GROK_OK");
    assert.equal(result.usage.inputTokens, 3);
    const chatRequests = requests.filter((request) => request.url.includes("chat/completions"));
    assert.equal(chatRequests.length, 2);
    assert.equal(chatRequests[1].init.headers.Authorization, "Bearer fresh-token");
    const body = JSON.parse(chatRequests[0].init.body);
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.reasoning, undefined);
    assert.equal(body.session_id, undefined);
    assert.match(body.messages[0].content, /active provider is xAI/);
    assert.equal(JSON.stringify(result).includes("fresh-token"), false);

    await assert.rejects(
      runXai({ ...config, xaiBaseUrl: "https://evil.example/v1" }, [user("hi")], [], async () => { throw new Error("must not fetch"); }),
      /refusing to send the xAI token/,
    );
    const proxied = [];
    await runXai(
      { ...config, xaiSubscriptionModels: ["grok-4.6"] },
      [user("Reply with exactly GROK_OK")],
      [],
      async (url, init) => {
        proxied.push(url);
        return json({ choices: [{ message: { content: "ok" } }] });
      },
    );
    assert.deepEqual(proxied, ["https://cli-chat-proxy.grok.com/v1/chat/completions"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Anthropic runs through the Claude Agent SDK, resumes a session, and returns structured tool calls", async () => {
  const calls = [];
  const makeQuery = (finalResult) => function* fakeQuery({ prompt, options }) {
    calls.push({ prompt, options });
    yield { type: "system", session_id: "claude-session-9" };
    yield { type: "result", subtype: "success", session_id: "claude-session-9", result: finalResult, usage: { input_tokens: 20, output_tokens: 5 } };
  };
  const structured = JSON.stringify({
    text: "",
    toolCalls: [{ toolCallId: "call-1", toolName: "Computer", argumentsJson: "{\"action\":\"screenshot\"}" }],
  });
  const result = await runAnthropic(
    { anthropicModel: "claude-sonnet-5", anthropicReasoning: "xhigh", anthropicSessionId: "resume-me", tempDirectory: tmpdir(), workingDirectory: "/workspace" },
    [user("Take a screenshot")],
    [{ name: "Computer", inputSchema: { type: "object" } }],
    () => makeQuery(structured),
  );
  assert.equal(calls[0].options.resume, "resume-me");
  assert.equal(calls[0].options.model, "claude-sonnet-5");
  assert.equal(calls[0].options.effort, "xhigh");
  assert.equal(calls[0].options.cwd, "/workspace");
  assert.equal(calls[0].options.permissionMode, "bypassPermissions");
  assert.match(calls[0].prompt, /active provider is Anthropic \(Claude Agent SDK\)/);
  assert.match(calls[0].prompt, /active model is claude-sonnet-5/);
  assert.equal(result.threadId, "claude-session-9");
  assert.equal(result.toolCalls[0].toolName, "Computer");
  assert.equal(result.usage.inputTokens, 20);

  const plain = await runAnthropic(
    { anthropicModel: "claude-haiku-4-5" },
    [user("Reply with exactly PONG")],
    [],
    () => makeQuery(JSON.stringify({ text: "PONG", toolCalls: [] })),
  );
  assert.equal(plain.text, "PONG");
  assert.equal(calls[1].options.resume, undefined);
  assert.equal(calls[1].options.effort, "medium");

  let attempts = 0;
  const failingResume = () => function* query({ options }) {
    attempts += 1;
    if (options.resume) throw new Error("No conversation found");
    yield { type: "result", subtype: "success", session_id: "new-session", result: JSON.stringify({ text: "recovered", toolCalls: [] }) };
  };
  const recovered = await runAnthropic({ anthropicSessionId: "gone" }, [user("hi")], [], failingResume);
  assert.equal(attempts, 2);
  assert.equal(recovered.threadId, "new-session");

  await assert.rejects(
    runAnthropic({}, [user("hi")], [], () => function* query() {
      yield { type: "result", subtype: "error_max_turns", result: "" };
    }),
    /ended with error_max_turns/,
  );
});
