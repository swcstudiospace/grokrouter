import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chatUrl, chatsDirectoryFor, createChatServer, ensureToken } from "../runtime/serve.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokrouter-serve-"));
  const config = {
    enabled: true,
    mode: "delegation",
    provider: "openrouter",
    providers: ["openrouter", "xai", "anthropic"],
    openRouterModel: "anthropic/claude-opus-5.5",
    openRouterReasoning: "high",
    openRouterModels: ["anthropic/claude-opus-5.5"],
    xaiModel: "grok-4.6",
    xaiModels: ["grok-4.6"],
    anthropicModel: "claude-opus-5-5",
    anthropicModels: ["claude-opus-5-5"],
    workingDirectory: root,
    statePath: join(root, "conversation-states.json"),
    auditPath: join(root, "audit.jsonl"),
    openRouterCatalogPath: join(root, "catalog.json"),
    modelCatalogPath: join(root, "catalogs"),
    sleepImpl: async () => {},
  };
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen(`http://127.0.0.1:${server.address().port}`)));
}

function parseEvents(text) {
  return text.split("\n\n").filter(Boolean).map((frame) => ({
    event: frame.match(/^event: (.+)$/m)?.[1],
    data: JSON.parse(frame.match(/^data: (.+)$/m)?.[1] || "null"),
  }));
}

test("the chat token is created once with owner-only permissions and reused afterwards", async () => {
  const { root, cleanup } = await fixture();
  try {
    const pathname = join(root, "nested", "chat-token");
    const first = await ensureToken(pathname, { randomImpl: () => "fixture-token-0123456789" });
    assert.equal(first, "fixture-token-0123456789");
    assert.equal((await stat(pathname)).mode & 0o777, 0o600);
    const second = await ensureToken(pathname, { randomImpl: () => "should-not-be-used" });
    assert.equal(second, first);
    assert.equal(chatUrl("0.0.0.0", 7878, first), "http://127.0.0.1:7878/?token=fixture-token-0123456789");
    assert.equal(chatsDirectoryFor({ statePath: join(root, "conversation-states.json") }), join(root, "chats"));
  } finally {
    await cleanup();
  }
});

test("chats are created, messages stream to the delegated provider with history, and controls change the chat's selection", async () => {
  const { root, config, cleanup } = await fixture();
  const seen = [];
  const runDelegationImpl = async (input, dependencies) => {
    seen.push(input);
    dependencies.onProgress("[OpenRouter] shell ls");
    return { ok: true, botId: input.botId, provider: "openrouter", model: "anthropic/claude-opus-5.5", reasoning: "high", text: `Echo: ${input.task}`, steps: 2, durationMs: 1500 };
  };
  const server = createChatServer({ config, token: "secret-token-abcdefgh", runDelegationImpl, page: "<!doctype html><title>GrokRouter Chat</title>" });
  const base = await listen(server);
  const headers = { "content-type": "application/json", authorization: "Bearer secret-token-abcdefgh" };
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /GrokRouter Chat/);
    assert.equal((await fetch(`${base}/api/chats`)).status, 401);
    assert.equal((await fetch(`${base}/api/chats`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${base}/api/chats?token=secret-token-abcdefgh`)).status, 200);

    const anonHealth = await fetch(`${base}/api/health`);
    assert.equal(anonHealth.status, 200);
    const anonBody = await anonHealth.json();
    assert.equal(anonBody.service, "grokrouter");
    assert.equal(anonBody.authenticated, false);
    assert.equal(anonBody.installSource, undefined);
    assert.equal((await fetch(`${base}/api/health`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    const authHealth = await (await fetch(`${base}/api/health`, { headers })).json();
    assert.equal(authHealth.service, "grokrouter");
    assert.equal(authHealth.authenticated, true);
    assert.equal(authHealth.mode, "delegation");
    assert.equal(authHealth.mcp, "/mcp");

    const created = await (await fetch(`${base}/api/chats`, { method: "POST", headers, body: "{}" })).json();
    assert.match(created.chat.id, /^[a-z0-9]{12}$/);
    assert.equal(created.status.provider, "openrouter");
    assert.equal(created.status.model, "anthropic/claude-opus-5.5");
    const id = created.chat.id;

    const first = await fetch(`${base}/api/chats/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "list the workspace" }) });
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type"), /text\/event-stream/);
    const events = parseEvents(await first.text());
    assert.deepEqual(events.map((entry) => entry.event), ["message", "progress", "message", "done"]);
    assert.equal(events[1].data.line, "[OpenRouter] shell ls");
    assert.equal(events[2].data.role, "assistant");
    assert.equal(events[2].data.text, "Echo: list the workspace");
    assert.match(events[2].data.trailer, /^\[GrokRouter .* · OpenRouter · anthropic\/claude-opus-5\.5 · high · 2 steps · 2s\]$/);
    assert.equal(seen[0].botId, `chat:${id}`);
    assert.equal(seen[0].mode, "chat");
    assert.deepEqual(seen[0].history, []);

    const second = parseEvents(await (await fetch(`${base}/api/chats/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "and now?" }) })).text());
    assert.equal(second.at(-2).data.text, "Echo: and now?");
    assert.deepEqual(seen[1].history, [
      { role: "user", content: "list the workspace" },
      { role: "assistant", content: "Echo: list the workspace" },
    ]);

    const control = parseEvents(await (await fetch(`${base}/api/chats/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "/provider xai" }) })).text());
    assert.equal(control[1].data.role, "control");
    assert.match(control[1].data.text, /to xAI \(grok-4\.6\)/);
    assert.equal(control.at(-1).data.status.provider, "xai");

    const listed = await (await fetch(`${base}/api/chats`, { headers })).json();
    assert.equal(listed.chats.length, 1);
    assert.equal(listed.chats[0].title, "list the workspace");
    assert.equal(listed.chats[0].messages, 6);
    const transcript = JSON.parse(await readFile(join(root, "chats", `${id}.json`), "utf8"));
    assert.deepEqual(transcript.messages.map((entry) => entry.role), ["user", "assistant", "user", "assistant", "user", "control"]);

    const detail = await (await fetch(`${base}/api/chats/${id}`, { headers })).json();
    assert.equal(detail.status.provider, "xai");
    assert.equal(detail.busy, false);
    assert.equal((await fetch(`${base}/api/chats/zzzzzzzzzzzz`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/api/chats/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "   " }) })).status, 400);

    assert.equal((await fetch(`${base}/api/chats/${id}`, { method: "DELETE", headers })).status, 200);
    assert.equal((await (await fetch(`${base}/api/chats`, { headers })).json()).chats.length, 0);
  } finally {
    server.close();
    await cleanup();
  }
});

test("a failed delegation is recorded in the transcript as an error and the chat is free again", async () => {
  const { root, config, cleanup } = await fixture();
  const runDelegationImpl = async () => { throw new Error("Delegation failed [auth]: OpenRouter rejected the credential sk-or-v1-secretsecretsecretsecret"); };
  const server = createChatServer({ config, token: "secret-token-abcdefgh", runDelegationImpl, page: "<p>page</p>" });
  const base = await listen(server);
  const headers = { "content-type": "application/json", authorization: "Bearer secret-token-abcdefgh" };
  try {
    const { chat } = await (await fetch(`${base}/api/chats`, { method: "POST", headers, body: JSON.stringify({ title: "failing" }) })).json();
    const events = parseEvents(await (await fetch(`${base}/api/chats/${chat.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "do it" }) })).text());
    assert.equal(events[1].data.role, "error");
    assert.match(events[1].data.text, /Delegation failed \[auth\]/);
    assert.doesNotMatch(events[1].data.text, /secretsecret/);
    const detail = await (await fetch(`${base}/api/chats/${chat.id}`, { headers })).json();
    assert.equal(detail.busy, false);
    assert.equal(detail.chat.messages.at(-1).role, "error");
    assert.ok((await readFile(join(root, "chats", `${chat.id}.json`), "utf8")).length > 0);
  } finally {
    server.close();
    await cleanup();
  }
});

test("the MCP endpoint speaks JSON-RPC over HTTP, lists its tools, delegates with progress, and shares the chat token", async () => {
  const { config, cleanup } = await fixture();
  const seen = [];
  const runDelegationImpl = async (input, dependencies) => {
    seen.push(input);
    dependencies.onProgress("[Anthropic] shell ls");
    dependencies.onProgress("[Anthropic] read_file README.md");
    return { ok: true, botId: input.botId, provider: "anthropic", model: "claude-opus-5-5", reasoning: "xhigh", text: `Done: ${input.task}`, steps: 3, durationMs: 4200 };
  };
  const upgrades = [];
  const upgradeImpl = async (input) => { upgrades.push(input); return { started: true, pid: 4242, log: "/tmp/upgrade.log" }; };
  const server = createChatServer({ config: { ...config, installSource: "swcstudiospace/grokrouter@main" }, token: "secret-token-abcdefgh", runDelegationImpl, upgradeImpl, page: "<p>page</p>" });
  const base = await listen(server);
  const headers = { "content-type": "application/json", authorization: "Bearer secret-token-abcdefgh", accept: "application/json" };
  const rpc = async (payload, extra = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(payload) });
  try {
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { headers })).status, 405);
    const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })).json();
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "grokrouter");
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const tools = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["delegate", "control", "status", "list_chats", "upgrade"]);
    assert.deepEqual(tools.result.tools[0].inputSchema.required, ["task"]);

    const control = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "control", arguments: { text: "/provider anthropic", bot: "vps-hermes" } } })).json();
    assert.equal(control.result.isError, undefined);
    assert.match(control.result.content[0].text, /to Anthropic \(claude-opus-5-5\)/);
    const status = await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "status", arguments: { bot: "vps-hermes" } } })).json();
    assert.equal(status.result.structuredContent.bot, "mcp:vps-hermes");
    assert.equal(status.result.structuredContent.provider, "anthropic");

    const plain = await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "delegate", arguments: { task: "list the repo", bot: "vps-hermes" } } })).json();
    assert.equal(plain.result.isError, undefined);
    assert.match(plain.result.content[0].text, /^Done: list the repo\n\n\[GrokRouter .* · Anthropic · claude-opus-5-5 · xhigh · 3 steps · 4s\]$/);
    assert.equal(plain.result.structuredContent.bot, "mcp:vps-hermes");
    assert.equal(seen[0].botId, "mcp:vps-hermes");
    assert.equal(seen[0].mode, undefined);

    const streamed = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "delegate", arguments: { task: "again" }, _meta: { progressToken: "p1" } } }, { accept: "application/json, text/event-stream" });
    assert.match(streamed.headers.get("content-type"), /text\/event-stream/);
    const events = parseEvents(await streamed.text()).map((entry) => entry.data);
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p1", progress: 1, message: "[Anthropic] shell ls" } });
    assert.equal(events[2].id, 6);
    assert.match(events[2].result.content[0].text, /^Done: again/);
    assert.equal(seen[1].botId, "mcp:mcp");

    const unknown = await (await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope", arguments: {} } })).json();
    assert.equal(unknown.error.code, -32602);
    const missing = await (await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "delegate", arguments: {} } })).json();
    assert.equal(missing.result.isError, true);
    const method = await (await rpc({ jsonrpc: "2.0", id: 9, method: "resources/list" })).json();
    assert.equal(method.error.code, -32601);
    const bad = await rpc({ nope: true });
    assert.equal(bad.status, 400);

    await (await fetch(`${base}/api/chats`, { method: "POST", headers, body: JSON.stringify({ title: "from the ui" }) })).json();
    const chats = await (await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_chats", arguments: {} } })).json();
    assert.equal(chats.result.structuredContent.chats.length, 1);
    assert.match(chats.result.content[0].text, /from the ui/);
    const viaChat = await (await rpc({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "delegate", arguments: { task: "continue", bot: chats.result.structuredContent.chats[0].id } } })).json();
    assert.equal(viaChat.result.structuredContent.bot, `chat:${chats.result.structuredContent.chats[0].id}`);

    assert.equal(status.result.structuredContent.installSource, "swcstudiospace/grokrouter@main");
    assert.ok(status.result.structuredContent.version);
    const upgrade = await (await rpc({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "upgrade", arguments: { ref: "feat/next" } } })).json();
    assert.match(upgrade.result.content[0].text, /Upgrade started from swcstudiospace\/grokrouter@feat\/next/);
    assert.deepEqual(upgrades, [{ ref: "feat/next" }]);
    const badRef = await (await rpc({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "upgrade", arguments: { ref: "../evil" } } })).json();
    assert.equal(badRef.result.isError, true);
    assert.equal(upgrades.length, 1);
  } finally {
    server.close();
    await cleanup();
  }
});
