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
