import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCAL_TOOLS,
  botStatus,
  delegationBotKey,
  executeLocalTool,
  formatDelegationTrailer,
  runControl,
  runDelegation,
} from "../runtime/delegate.mjs";

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokrouter-delegate-"));
  const config = {
    enabled: true,
    mode: "delegation",
    provider: "openrouter",
    providers: ["codex", "openrouter", "anthropic", "xai"],
    codexModel: "gpt-5.6-sol",
    openRouterModel: "anthropic/claude-sonnet-5",
    anthropicModel: "claude-sonnet-5",
    xaiModel: "grok-4.6",
    workingDirectory: root,
    statePath: join(root, "states.json"),
    auditPath: join(root, "audit.jsonl"),
    modelCatalogPath: join(root, "catalog"),
  };
  const audit = async () => (await readFile(config.auditPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { root, config, audit, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("the local tool loop runs OpenRouter tools in the workspace and reports the final answer", async () => {
  const { root, config, audit, cleanup } = await fixture();
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = ["sk", "or", "v1", "syntheticfixture0000000000000000"].join("-");
  try {
    const requests = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if (requests.length === 1) {
        assert.equal(body.model, "anthropic/claude-sonnet-5");
        assert.deepEqual(body.tools, LOCAL_TOOLS);
        assert.equal(body.messages[0].role, "system");
        assert.equal(body.messages[1].content, "Create hello.txt containing hi");
        assert.deepEqual(body.reasoning, { effort: "medium" });
        return json({ choices: [{ message: {
          content: "",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "hi\n" }) } }],
        } }] });
      }
      if (requests.length === 2) {
        const toolMessage = body.messages.at(-1);
        assert.equal(toolMessage.role, "tool");
        assert.equal(toolMessage.tool_call_id, "call-1");
        assert.match(toolMessage.content, /wrote 3 bytes/);
        return json({ choices: [{ message: {
          content: "",
          tool_calls: [{ id: "call-2", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "cat hello.txt" }) } }],
        } }] });
      }
      assert.match(body.messages.at(-1).content, /stdout:\nhi/);
      return json({ choices: [{ message: { content: "Created hello.txt and verified it prints hi." } }] });
    };
    const progress = [];
    const result = await runDelegation({
      config, task: "Create hello.txt containing hi", botId: "bot-loop",
    }, { fetchImpl, onProgress: (line) => progress.push(line) });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "openrouter");
    assert.equal(result.model, "anthropic/claude-sonnet-5");
    assert.equal(result.text, "Created hello.txt and verified it prints hi.");
    assert.equal(result.steps, 3);
    assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "hi\n");
    assert.deepEqual(progress.map((line) => line.split(" ")[1]), ["write_file", "shell"]);
    assert.match(formatDelegationTrailer(result), /\[GrokRouter .* · OpenRouter · anthropic\/claude-sonnet-5 · medium · 3 steps · \d+s\]/);

    const events = await audit();
    assert.deepEqual(events.map((event) => event.event), ["delegation_start", "delegation_ok"]);
    assert.equal(events[0].botId, "bot-loop");
    assert.equal(events[1].steps, 3);
    assert.equal(JSON.stringify(events).includes("syntheticfixture"), false);
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    await cleanup();
  }
});

test("a tool loop that never answers stops at the step limit and records the failure", async () => {
  const { config, audit, cleanup } = await fixture();
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = ["sk", "or", "v1", "syntheticfixture0000000000000000"].join("-");
  try {
    const fetchImpl = async () => json({ choices: [{ message: {
      content: "",
      tool_calls: [{ id: "loop", type: "function", function: { name: "list_dir", arguments: "{}" } }],
    } }] });
    await assert.rejects(
      runDelegation({ config, task: "loop forever", botId: "bot-limit", maxSteps: 2 }, { fetchImpl }),
      /Stopped after 2 model steps/,
    );
    const events = await audit();
    assert.equal(events.at(-1).event, "delegation_error");
    assert.match(events.at(-1).error, /Stopped after 2 model steps/);
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    await cleanup();
  }
});

test("Anthropic delegation resumes the Bot's session for the same model and starts fresh on a switch", async () => {
  const { config, cleanup } = await fixture();
  try {
    const seen = [];
    const queryFactory = () => ({ prompt, options }) => {
      seen.push({ prompt, options });
      return (async function* () {
        yield { type: "system", session_id: `session-${seen.length}` };
        yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } };
        yield { type: "result", subtype: "success", result: `done ${seen.length}`, usage: {} };
      })();
    };
    await runControl({ config, botId: "bot-claude", text: "/provider anthropic" });
    await runControl({ config, botId: "bot-claude", text: "/model claude-opus-5-5" });
    await runControl({ config, botId: "bot-claude", text: "/reasoning xhigh" });
    const first = await runDelegation({ config, task: "first", botId: "bot-claude" }, { anthropicQueryFactory: queryFactory });
    assert.equal(first.provider, "anthropic");
    assert.equal(first.model, "claude-opus-5-5");
    assert.equal(first.reasoning, "xhigh");
    assert.equal(first.text, "done 1");
    assert.equal(seen[0].options.model, "claude-opus-5-5");
    assert.equal(seen[0].options.effort, "xhigh");
    assert.equal(seen[0].options.permissionMode, "bypassPermissions");
    assert.equal(seen[0].options.resume, undefined);
    assert.equal(seen[0].options.cwd, config.workingDirectory);

    const second = await runDelegation({ config, task: "second", botId: "bot-claude" }, { anthropicQueryFactory: queryFactory });
    assert.equal(second.text, "done 2");
    assert.equal(seen[1].options.resume, "session-1");
    assert.equal((await botStatus({ config, botId: "bot-claude" })).delegation.anthropic.sessionId, "session-2");

    await runDelegation({ config, task: "third", botId: "bot-claude", model: "claude-sonnet-5" }, { anthropicQueryFactory: queryFactory });
    assert.equal(seen[2].options.resume, undefined);
    assert.equal(seen[2].options.model, "claude-sonnet-5");

    await runDelegation({ config, task: "fourth", botId: "bot-claude", fresh: true }, { anthropicQueryFactory: queryFactory });
    assert.equal(seen[3].options.resume, undefined);
  } finally {
    await cleanup();
  }
});

test("Codex delegation keeps the Bot's thread and reports command steps", async () => {
  const { config, cleanup } = await fixture();
  try {
    const calls = [];
    const thread = (id) => ({
      id,
      run: async (task) => {
        calls.push({ id, task });
        return { finalResponse: `codex ${task}`, items: [{ type: "command_execution", command: "npm test" }, { type: "agent_message" }] };
      },
    });
    const codexFactory = () => ({
      startThread: (options) => { calls.push({ start: options.model, effort: options.modelReasoningEffort, cwd: options.workingDirectory }); return thread("thread-a"); },
      resumeThread: (id, options) => { calls.push({ resume: id, model: options.model }); return thread(id); },
    });
    const progress = [];
    const first = await runDelegation({ config, task: "run tests", botId: "bot-codex", provider: "codex" }, { codexFactory, onProgress: (line) => progress.push(line) });
    assert.equal(first.model, "gpt-5.6-sol");
    assert.equal(first.text, "codex run tests");
    assert.equal(first.steps, 2);
    assert.deepEqual(progress, ["[Codex SDK] shell npm test"]);
    assert.equal(calls[0].start, "gpt-5.6-sol");
    assert.equal(calls[0].cwd, config.workingDirectory);

    const status = await botStatus({ config, botId: "bot-codex" });
    assert.equal(status.provider, "openrouter", "a one-off --provider does not change the Bot's default");
    assert.equal(status.delegation.codex.threadId, "thread-a");

    await runDelegation({ config, task: "again", botId: "bot-codex", provider: "codex" }, { codexFactory });
    assert.equal(calls.at(-2).resume, "thread-a");
  } finally {
    await cleanup();
  }
});

test("controls change the Bot's delegation defaults and a provider switch drops old threads", async () => {
  const { config, audit, cleanup } = await fixture();
  try {
    const initial = await botStatus({ config, botId: "bot-control" });
    assert.equal(initial.provider, "openrouter");
    const unknown = await runControl({ config, botId: "bot-control", text: "hello there" });
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /Not a GrokRouter control/);

    const switched = await runControl({ config, botId: "bot-control", text: "/provider anthropic" });
    assert.equal(switched.ok, true);
    assert.equal(switched.provider, "anthropic");
    assert.match(switched.text, /Switched this bot/);
    const model = await runControl({ config, botId: "bot-control", text: "/model claude-opus-5-5" });
    assert.match(model.text, /claude-opus-5-5/);
    const reasoning = await runControl({ config, botId: "bot-control", text: "/reasoning xhigh" });
    assert.match(reasoning.text, /xhigh/);
    const status = await botStatus({ config, botId: "bot-control" });
    assert.equal(status.provider, "anthropic");
    assert.equal(status.model, "claude-opus-5-5");
    assert.equal(status.reasoning, "xhigh");
    const receipt = await runControl({ config, botId: "bot-control", text: "/provider" });
    assert.equal(receipt.text, "Anthropic is active for this bot. Model: claude-opus-5-5. Reasoning: xhigh.");
    const events = await audit();
    assert.equal(events.filter((event) => event.event === "control_turn" && event.mode === "delegation").length, 4);
  } finally {
    await cleanup();
  }
});

test("a disabled provider or unknown provider is refused before any request", async () => {
  const { config, cleanup } = await fixture();
  try {
    await assert.rejects(runDelegation({ config: { ...config, providers: ["codex"] }, task: "x", botId: "bot-refuse", provider: "openrouter" }), /not enabled/);
    await assert.rejects(runDelegation({ config, task: "x", botId: "bot-refuse", provider: "gemini" }), /Unknown provider/);
    await assert.rejects(runDelegation({ config, task: "   ", botId: "bot-refuse" }), /task is required/);
    await assert.rejects(runDelegation({ config: { ...config, enabled: false }, task: "x", botId: "bot-refuse" }), /disabled on this Bot computer/);
  } finally {
    await cleanup();
  }
});

test("local tools stay inside the working directory by default and never throw", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokrouter-tools-"));
  try {
    assert.match(await executeLocalTool({ function: { name: "write_file", arguments: JSON.stringify({ path: "nested/a.txt", content: "x" }) } }, { cwd: root }), /wrote 1 bytes/);
    assert.equal(await executeLocalTool({ function: { name: "read_file", arguments: JSON.stringify({ path: "nested/a.txt" }) } }, { cwd: root }), "x");
    assert.match(await executeLocalTool({ function: { name: "list_dir", arguments: JSON.stringify({ path: "nested" }) } }, { cwd: root }), /file 1 a\.txt/);
    assert.match(await executeLocalTool({ function: { name: "read_file", arguments: JSON.stringify({ path: "missing.txt" }) } }, { cwd: root }), /^error: /);
    assert.match(await executeLocalTool({ function: { name: "shell", arguments: "{not json" } }, { cwd: root }), /not valid JSON/);
    assert.match(await executeLocalTool({ function: { name: "shell", arguments: JSON.stringify({ command: "sleep 5", timeout_seconds: 1 }) } }, { cwd: root }), /timed out after 1s/);
    assert.equal(delegationBotKey("explicit"), "explicit");
    assert.match(delegationBotKey(""), /^box:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
