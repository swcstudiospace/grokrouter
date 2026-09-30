import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadProviderModels, xaiSubscriptionModelIds } from "./model-catalog.mjs";
import {
  ANTHROPIC_EFFORT,
  PROVIDER_IDS,
  ROUTER_VERSION,
  appendAudit,
  classifyProviderError,
  codexThreadOptions,
  controlResult,
  createAnthropicQuery,
  createCodexClient,
  defaultModel,
  defaultReasoning,
  doctorText,
  loadRuntimeConfig,
  mergeState,
  persistedOpenRouterKey,
  providerLabel,
  redactDiagnostic,
  stateForTurn,
} from "./run-provider.mjs";
import {
  XAI_API_BASE_URL,
  XAI_SUBSCRIPTION_BASE_URL,
  accessToken as xaiAccessToken,
  assertBearerOrigin,
} from "./xai-oauth.mjs";

const DEFAULT_MAX_STEPS = 40;
const MAX_TOOL_OUTPUT_CHARS = 24_000;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_SHELL_TIMEOUT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 15 * 60_000;
const XAI_EFFORT = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" };

export const LOCAL_TOOLS = [
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a bash command in the Bot computer and return its stdout, stderr and exit code. Long output is truncated.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command line to run." },
          timeout_seconds: { type: "integer", description: "Seconds before the command is killed (default 120, max 600)." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file. Paths are relative to the working directory unless absolute.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          max_chars: { type: "integer", description: "Maximum characters to return (default 24000)." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 text file, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries of a directory with their types.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory to list (default: working directory)." } },
        additionalProperties: false,
      },
    },
  },
];

export function delegationBotKey(explicit) {
  const value = String(explicit || process.env.GROKBOT_ROUTER_BOT || "").trim();
  return value || `box:${hostname()}`;
}

function truncate(text, limit = MAX_TOOL_OUTPUT_CHARS) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  const kept = Math.floor(limit / 2);
  return `${value.slice(0, kept)}\n…[${value.length - limit} characters omitted]…\n${value.slice(-kept)}`;
}

function resolvePath(cwd, value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("path is required");
  return isAbsolute(text) ? text : resolve(cwd, text);
}

export function runShell(command, { cwd, timeoutMs = DEFAULT_SHELL_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolveResult) => {
    const child = spawnImpl("bash", ["-lc", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { if (stdout.length < 4 * MAX_TOOL_OUTPUT_CHARS) stdout += chunk; });
    child.stderr?.on("data", (chunk) => { if (stderr.length < 4 * MAX_TOOL_OUTPUT_CHARS) stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ exitCode: code, signal, stdout, stderr, timedOut });
    });
  });
}

export async function executeLocalTool(call, { cwd, spawnImpl } = {}) {
  const name = String(call?.function?.name || call?.name || "");
  let args = {};
  try {
    const raw = call?.function?.arguments ?? call?.arguments ?? call?.args ?? {};
    args = typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : {}) : raw;
  } catch (error) {
    return `error: tool arguments were not valid JSON (${error.message})`;
  }
  try {
    if (name === "shell") {
      const command = String(args.command || "").trim();
      if (!command) return "error: command is required";
      const seconds = Number(args.timeout_seconds);
      const timeoutMs = Number.isFinite(seconds) && seconds > 0
        ? Math.min(seconds * 1000, MAX_SHELL_TIMEOUT_MS)
        : DEFAULT_SHELL_TIMEOUT_MS;
      const result = await runShell(command, { cwd, timeoutMs, spawnImpl });
      const lines = [`exit code: ${result.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : result.exitCode ?? result.signal ?? "unknown"}`];
      if (result.stdout.trim()) lines.push(`stdout:\n${truncate(result.stdout)}`);
      if (result.stderr.trim()) lines.push(`stderr:\n${truncate(result.stderr)}`);
      return lines.join("\n");
    }
    if (name === "read_file") {
      const pathname = resolvePath(cwd, args.path);
      const limit = Number.isFinite(Number(args.max_chars)) && Number(args.max_chars) > 0
        ? Math.min(Number(args.max_chars), 4 * MAX_TOOL_OUTPUT_CHARS)
        : MAX_TOOL_OUTPUT_CHARS;
      return truncate(await readFile(pathname, "utf8"), limit);
    }
    if (name === "write_file") {
      const pathname = resolvePath(cwd, args.path);
      const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
      await mkdir(dirname(pathname), { recursive: true });
      await writeFile(pathname, content, "utf8");
      return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${pathname}`;
    }
    if (name === "list_dir") {
      const pathname = args.path ? resolvePath(cwd, args.path) : cwd;
      const entries = await readdir(pathname, { withFileTypes: true });
      const rows = [];
      for (const entry of entries.slice(0, 500)) {
        let size = "";
        if (entry.isFile()) {
          try {
            size = ` ${(await stat(resolve(pathname, entry.name))).size}`;
          } catch {}
        }
        rows.push(`${entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file"}${size} ${entry.name}`);
      }
      return rows.join("\n") || "(empty)";
    }
    return `error: unknown tool ${name || "(unnamed)"}`;
  } catch (error) {
    return `error: ${redactDiagnostic(error?.message || error, 400)}`;
  }
}

const CHAT_GUIDANCE = [
  "You are the assistant behind a GrokRouter chat that runs inside a Grok Bot computer (Linux); the person is talking to you directly and Grok is not involved.",
  "Answer conversationally and to the point. Use the shell, files and browser only when the request needs them, and say what you did when you do.",
  "You may ask a short clarifying question when the request is ambiguous.",
].join(" ");

function delegationSystemPrompt(cwd, provider, model, mode = "task") {
  if (mode === "chat") {
    return [
      CHAT_GUIDANCE,
      `Working directory: ${cwd}. Provider: ${providerLabel(provider)}; model: ${model}.`,
      "Tools: shell, read_file, write_file and list_dir. Never print tool-call markup as text; call tools natively.",
    ].join(" ");
  }
  return [
    "You are the engineer that GrokRouter delegated this task to. You are working inside a Grok Bot computer (Linux).",
    `Working directory: ${cwd}. Provider: ${providerLabel(provider)}; model: ${model}.`,
    "Use the shell, read_file, write_file and list_dir tools to inspect the workspace, make changes and verify them. Prefer small, checked steps.",
    "Do not ask the user questions; make reasonable assumptions and state them. Never print tool-call markup as text; call tools natively.",
    "When the task is complete, reply with a concise plain-text report: what you did, which files changed, and how it was verified.",
  ].join(" ");
}

const HISTORY_MESSAGE_LIMIT = 24;
const HISTORY_CHARACTER_LIMIT = 60_000;

export function conversationHistory(entries) {
  const turns = (Array.isArray(entries) ? entries : [])
    .filter((entry) => (entry?.role === "user" || entry?.role === "assistant") && typeof entry.content === "string" && entry.content.trim())
    .slice(-HISTORY_MESSAGE_LIMIT)
    .map((entry) => ({ role: entry.role, content: entry.content.slice(0, 12_000) }));
  let total = turns.reduce((sum, turn) => sum + turn.content.length, 0);
  while (turns.length && total > HISTORY_CHARACTER_LIMIT) total -= turns.shift().content.length;
  return turns;
}

async function xaiDelegationBaseUrl(config, model) {
  const subscription = await xaiSubscriptionModelIds(config).catch(() => []);
  if (subscription.includes(model)) return String(config.xaiSubscriptionBaseUrl || XAI_SUBSCRIPTION_BASE_URL).replace(/\/$/, "");
  return String(config.xaiBaseUrl || XAI_API_BASE_URL).replace(/\/$/, "");
}

async function toolLoopTransport(config, providerId, model, reasoning, fetchImpl) {
  if (providerId === "openrouter") {
    const key = await persistedOpenRouterKey(config);
    return {
      baseUrl: String(config.openRouterBaseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
      bearer: async () => key,
      extras: { reasoning: { effort: reasoning } },
      guard: null,
    };
  }
  if (providerId === "xai") {
    let refreshed = false;
    return {
      baseUrl: await xaiDelegationBaseUrl(config, model),
      bearer: async ({ retryAfterUnauthorized = false } = {}) => {
        if (retryAfterUnauthorized && !refreshed) {
          refreshed = true;
          return xaiAccessToken(config, fetchImpl, { forceRefresh: true });
        }
        return xaiAccessToken(config, fetchImpl);
      },
      extras: { reasoning_effort: XAI_EFFORT[reasoning] || "medium" },
      guard: assertBearerOrigin,
    };
  }
  throw new Error(`Provider ${providerId} has no local tool loop`);
}

async function chatCompletion(transport, body, fetchImpl, sleep) {
  const endpoint = `${transport.baseUrl}/chat/completions`;
  if (transport.guard) transport.guard(endpoint);
  const retried = { token: false, transient: false, optional: false };
  const request = async (requestBody) => {
    const token = await transport.bearer({ retryAfterUnauthorized: retried.token });
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Title": "GrokRouter" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && !retried.token && transport.guard) {
      retried.token = true;
      return request(requestBody);
    }
    if ((response.status === 429 || response.status >= 500) && !retried.transient) {
      retried.transient = true;
      const advertised = Number(response.headers?.get?.("retry-after")) * 1000;
      await sleep(Number.isFinite(advertised) && advertised > 0 ? Math.min(advertised, 5_000) : 1_000);
      return request(requestBody);
    }
    if (!response.ok || payload?.error) {
      const detail = typeof payload?.error?.message === "string" ? payload.error.message : "";
      if (response.status === 400 && !retried.optional && /reasoning|parallel_tool_calls|tool_choice/i.test(detail)) {
        retried.optional = true;
        const { reasoning: _r, reasoning_effort: _e, parallel_tool_calls: _p, tool_choice: _t, ...rest } = requestBody;
        return request(rest);
      }
      const error = new Error(`${transport.label || "provider"} request failed (${response.status})${detail ? `: ${detail}` : ""}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };
  return request(body);
}

export async function runToolLoop({
  config,
  providerId,
  task,
  model,
  reasoning,
  cwd,
  maxSteps = DEFAULT_MAX_STEPS,
  fetchImpl = fetch,
  spawnImpl,
  onProgress = () => {},
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  history = [],
  mode = "task",
}) {
  const transport = { label: providerLabel(providerId), ...(await toolLoopTransport(config, providerId, model, reasoning, fetchImpl)) };
  const messages = [
    { role: "system", content: delegationSystemPrompt(cwd, providerId, model, mode) },
    ...conversationHistory(history),
    { role: "user", content: task },
  ];
  let toolCalls = 0;
  for (let step = 1; step <= maxSteps; step += 1) {
    const payload = await chatCompletion(transport, {
      model,
      messages,
      tools: LOCAL_TOOLS,
      tool_choice: "auto",
      parallel_tool_calls: false,
      ...transport.extras,
      stream: false,
    }, fetchImpl, sleep);
    const message = payload?.choices?.[0]?.message ?? {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter((call) => call?.id && call?.function?.name) : [];
    const content = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content) ? message.content.map((part) => part?.text || "").join("") : "";
    if (!calls.length) {
      return { text: content.trim(), steps: step, toolCalls };
    }
    messages.push({ role: "assistant", content: content || null, tool_calls: calls });
    for (const call of calls) {
      toolCalls += 1;
      onProgress(`[${providerLabel(providerId)}] ${call.function.name} ${summarizeArguments(call.function.arguments)}`);
      const result = await executeLocalTool(call, { cwd, spawnImpl });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  throw new Error(`Stopped after ${maxSteps} model steps without a final answer. Raise --max-steps or narrow the task.`);
}

function summarizeArguments(raw) {
  try {
    const args = typeof raw === "string" ? JSON.parse(raw) : raw;
    const value = args?.command ?? args?.path ?? "";
    return String(value).replace(/\s+/g, " ").slice(0, 100);
  } catch {
    return "";
  }
}

export async function runAnthropicDelegation({ config, task, model, reasoning, cwd, previous, queryFactory, onProgress = () => {}, mode = "task" }) {
  const query = queryFactory ? queryFactory() : await createAnthropicQuery();
  const resumable = previous?.sessionId && previous.model === model ? previous.sessionId : null;
  const options = {
    cwd,
    model,
    effort: ANTHROPIC_EFFORT[reasoning] || "medium",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(mode === "chat" ? { systemPrompt: { type: "preset", preset: "claude_code", append: CHAT_GUIDANCE } } : {}),
    ...(config.anthropicExecutablePath ? { pathToClaudeCodeExecutable: config.anthropicExecutablePath } : {}),
    ...(resumable ? { resume: resumable } : {}),
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `grokrouter/${ROUTER_VERSION}` },
  };
  const run = async (runOptions) => {
    let sessionId = runOptions.resume || null;
    let finalText = "";
    let usage = {};
    let steps = 0;
    for await (const message of query({ prompt: task, options: runOptions })) {
      if (typeof message?.session_id === "string") sessionId = message.session_id;
      if (message?.type === "assistant") {
        steps += 1;
        const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
        for (const block of blocks) {
          if (block?.type === "tool_use") onProgress(`[Anthropic] ${block.name} ${summarizeArguments(block.input)}`);
        }
      }
      if (message?.type === "result") {
        if (message.subtype && message.subtype !== "success") {
          throw new Error(`Claude Agent SDK ended with ${message.subtype}`);
        }
        finalText = typeof message.result === "string" ? message.result : "";
        usage = message.usage || {};
      }
    }
    return { sessionId, finalText, usage, steps };
  };
  let outcome;
  try {
    outcome = await run(options);
  } catch (error) {
    if (!resumable) throw error;
    const { resume: _resume, ...fresh } = options;
    outcome = await run(fresh);
  }
  if (!outcome.finalText.trim()) throw new Error("Claude Agent SDK returned an empty response");
  return { text: outcome.finalText.trim(), steps: outcome.steps, thread: { sessionId: outcome.sessionId, model } };
}

export async function runCodexDelegation({ config, task, model, reasoning, cwd, previous, codexFactory, onProgress = () => {}, mode = "task" }) {
  const codex = codexFactory ? codexFactory() : await createCodexClient(config);
  const options = codexThreadOptions({ ...config, codexModel: model, codexReasoning: reasoning, workingDirectory: cwd, nativeTextTask: false });
  const resumable = previous?.threadId && previous.model === model ? previous.threadId : null;
  const prompt = mode === "chat" && !resumable ? `${CHAT_GUIDANCE}\n\n${task}` : task;
  let thread = resumable ? codex.resumeThread(resumable, options) : codex.startThread(options);
  let turn;
  try {
    turn = await thread.run(prompt);
  } catch (error) {
    if (!resumable) throw error;
    thread = codex.startThread(options);
    turn = await thread.run(prompt);
  }
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (const item of items) {
    if (item?.type === "command_execution" && item.command) onProgress(`[Codex SDK] shell ${String(item.command).slice(0, 100)}`);
  }
  const text = String(turn?.finalResponse || "").trim();
  if (!text) throw new Error("Codex SDK returned an empty response");
  return { text, steps: items.length || 1, thread: { threadId: thread.id, model } };
}

export async function runDelegation(input, dependencies = {}) {
  const config = input.config && typeof input.config === "object" ? input.config : {};
  const task = String(input.task || "").trim();
  if (!task) throw new Error("A task is required");
  if (config.enabled === false) throw new Error("GrokRouter is disabled on this Bot computer. Run grokbot-router enable, then try again.");
  const botId = delegationBotKey(input.botId);
  const { state, key } = await stateForTurn(config, [], { botId });
  const allowed = Array.isArray(config.providers) && config.providers.length ? config.providers : PROVIDER_IDS;
  const provider = String(input.provider || state.provider || "").toLowerCase();
  if (!PROVIDER_IDS.includes(provider)) throw new Error(`Unknown provider ${provider}`);
  if (!allowed.includes(provider)) throw new Error(`Provider ${provider} is not enabled. Available: ${allowed.join(", ")}.`);
  const model = String(input.model || (input.provider && provider !== state.provider ? defaultModel(config, provider) : state.model) || defaultModel(config, provider));
  const reasoning = String(input.reasoning || (input.provider && provider !== state.provider ? defaultReasoning(config, provider) : state.reasoning) || "medium");
  const cwd = input.cwd || config.workingDirectory || "/workspace";
  const previous = input.fresh ? null : state.delegation?.[provider] || null;
  const onProgress = dependencies.onProgress || (() => {});
  const mode = input.mode === "chat" ? "chat" : "task";
  const receipt = { botId, sessionId: state.sessionId, provider, model, reasoning, cwd, taskChars: task.length, mode };
  const startedAt = Date.now();
  await appendAudit(config, { event: "delegation_start", ...receipt });
  let outcome;
  try {
    if (provider === "anthropic") {
      outcome = await runAnthropicDelegation({ config, task, model, reasoning, cwd, previous, queryFactory: dependencies.anthropicQueryFactory, onProgress, mode });
    } else if (provider === "codex") {
      outcome = await runCodexDelegation({ config, task, model, reasoning, cwd, previous, codexFactory: dependencies.codexFactory, onProgress, mode });
    } else {
      outcome = await runToolLoop({
        config, providerId: provider, task, model, reasoning, cwd,
        maxSteps: Number(input.maxSteps) > 0 ? Number(input.maxSteps) : DEFAULT_MAX_STEPS,
        fetchImpl: dependencies.fetchImpl, spawnImpl: dependencies.spawnImpl, onProgress, sleep: dependencies.sleep,
        history: input.history, mode,
      });
    }
  } catch (error) {
    const { code, hint } = classifyProviderError(error, provider);
    await appendAudit(config, {
      event: "delegation_error", ...receipt, durationMs: Date.now() - startedAt,
      errorCode: code, hint, error: redactDiagnostic(error?.message || error),
    });
    const failure = new Error(`Delegation failed [${code}]: ${redactDiagnostic(error?.message || error, 400)}${hint ? ` ${hint}` : ""}`);
    failure.routerCode = code;
    failure.routerHint = hint;
    throw failure;
  }
  if (outcome.thread) {
    const delegation = { ...(state.delegation || {}), [provider]: outcome.thread };
    await mergeState(config, key, state, { delegation });
  }
  await appendAudit(config, { event: "delegation_ok", ...receipt, durationMs: Date.now() - startedAt, steps: outcome.steps, responseCharacters: outcome.text.length });
  return { ok: true, botId, provider, model, reasoning, text: outcome.text, steps: outcome.steps, durationMs: Date.now() - startedAt };
}

export async function runControl(input, dependencies = {}) {
  const config = input.config && typeof input.config === "object" ? input.config : {};
  const text = String(input.text || "").trim();
  const botId = delegationBotKey(input.botId);
  const { state, key } = await stateForTurn(config, [], { botId });
  const control = await controlResult(config, key, state, text, dependencies);
  if (!control) return { ok: false, botId, provider: state.provider, model: state.model, text: `Not a GrokRouter control: ${text || "(empty)"}. Send /router help for the list.` };
  if (/^\/router\s+reset$/i.test(text.replace(/\s+/g, " ")) || (control.provider !== state.provider)) {
    await mergeState(config, key, state, { delegation: {} });
  }
  await appendAudit(config, { event: "control_turn", controlCommand: text.split(/\s+/, 1)[0], sessionId: state.sessionId, identitySource: "bot", identityFields: ["botid"], provider: control.provider, model: control.model, mode: "delegation" });
  return { ok: true, botId, provider: control.provider, model: control.model, text: control.text };
}

export async function botStatus(input) {
  const config = input.config && typeof input.config === "object" ? input.config : {};
  const botId = delegationBotKey(input.botId);
  const { state } = await stateForTurn(config, [], { botId });
  return { botId, provider: state.provider, model: state.model, reasoning: state.reasoning, delegation: state.delegation || {} };
}

export function formatDelegationTrailer(result) {
  return `[GrokRouter ${ROUTER_VERSION} · ${providerLabel(result.provider)} · ${result.model} · ${result.reasoning} · ${result.steps} step${result.steps === 1 ? "" : "s"} · ${Math.round(result.durationMs / 1000)}s]`;
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (["fresh", "json", "status", "doctor", "help"].includes(name)) {
      options[name] = true;
      continue;
    }
    options[name] = argv[index + 1];
    index += 1;
  }
  return options;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function usage() {
  return [
    "GrokRouter delegation runner",
    "",
    "  node delegate.mjs --task \"<task>\" [--task-file FILE] [--bot ID] [--provider P] [--model M] [--reasoning R] [--cwd DIR] [--max-steps N] [--fresh] [--json]",
    "  node delegate.mjs --control \"/model claude-opus-5-5\" [--bot ID]",
    "  node delegate.mjs --status [--bot ID]",
    "  node delegate.mjs --doctor [--bot ID]",
    "",
    "The task is read from --task, --task-file, or stdin. Progress goes to stderr; the delegated model's final report goes to stdout,",
    "followed by a bracketed trailer naming the provider, model, reasoning and step count that produced it.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const config = await loadRuntimeConfig();
  const botId = options.bot;
  if (options.status) {
    const status = await botStatus({ config, botId });
    process.stdout.write(options.json ? `${JSON.stringify(status)}\n`
      : `${providerLabel(status.provider)} is active for this bot. Model: ${status.model}. Reasoning: ${status.reasoning}.\n`);
    return;
  }
  if (options.doctor) {
    const status = await botStatus({ config, botId });
    process.stdout.write(`${await doctorText(config, status)}\nMode: delegation (Grok Bot runs the conversation; GrokRouter runs delegated tasks in this Bot computer).\n`);
    return;
  }
  if (options.control !== undefined) {
    const result = await runControl({ config, botId, text: options.control }, { catalogFetch: fetch });
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.text}\n`);
    process.exitCode = result.ok ? 0 : 2;
    return;
  }
  let task = options.task || "";
  if (!task && options["task-file"]) task = await readFile(options["task-file"], "utf8");
  if (!task && !process.stdin.isTTY) task = await readStdin();
  if (!task.trim()) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await runDelegation({
    config,
    task,
    botId,
    provider: options.provider,
    model: options.model,
    reasoning: options.reasoning,
    cwd: options.cwd,
    maxSteps: options["max-steps"],
    fresh: Boolean(options.fresh),
  }, { onProgress: (line) => process.stderr.write(`${line}\n`) });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`${result.text}\n\n${formatDelegationTrailer(result)}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${redactDiagnostic(error?.message || error, 1_000)}\n`);
    process.exitCode = 1;
  });
}
