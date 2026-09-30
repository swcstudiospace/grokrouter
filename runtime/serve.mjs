import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ROUTER_VERSION,
  loadRuntimeConfig,
  providerLabel,
  redactDiagnostic,
} from "./run-provider.mjs";
import {
  botStatus,
  conversationHistory,
  formatDelegationTrailer,
  runControl,
  runDelegation,
} from "./delegate.mjs";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 7878;
export const DEFAULT_HOST = "127.0.0.1";
const CHAT_ID_PATTERN = /^[a-z0-9]{6,32}$/;
const MAX_BODY_BYTES = 256 * 1024;

export function chatsDirectoryFor(config) {
  return config.chatsPath || join(dirname(config.statePath || join(runtimeDirectory, "conversation-states.json")), "chats");
}

export async function ensureToken(pathname, { randomImpl = () => randomBytes(24).toString("base64url") } = {}) {
  try {
    const existing = (await readFile(pathname, "utf8")).trim();
    if (/^[A-Za-z0-9_-]{16,}$/.test(existing)) return existing;
  } catch {
    // A missing token file is created below.
  }
  const token = randomImpl();
  await mkdir(dirname(pathname), { recursive: true });
  await writeFile(pathname, `${token}\n`, { mode: 0o600 });
  return token;
}

function newChatId() {
  return randomBytes(6).toString("hex");
}

function chatTitle(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || "New chat";
}

class ChatStore {
  constructor(directory) {
    this.directory = directory;
  }

  pathFor(id) {
    if (!CHAT_ID_PATTERN.test(id)) throw Object.assign(new Error("Unknown chat"), { status: 404 });
    return join(this.directory, `${id}.json`);
  }

  async list() {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
    const chats = [];
    for (const name of names) {
      try {
        const chat = JSON.parse(await readFile(join(this.directory, name), "utf8"));
        if (CHAT_ID_PATTERN.test(chat?.id)) chats.push({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, messages: chat.messages.length });
      } catch {
        // Skip a transcript that is mid-write or damaged; the others still list.
      }
    }
    return chats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async create(title) {
    await mkdir(this.directory, { recursive: true });
    const now = new Date().toISOString();
    const chat = { id: newChatId(), title: chatTitle(title), createdAt: now, updatedAt: now, messages: [] };
    await this.save(chat);
    return chat;
  }

  async read(id) {
    try {
      const chat = JSON.parse(await readFile(this.pathFor(id), "utf8"));
      if (chat?.id !== id || !Array.isArray(chat.messages)) throw new Error("damaged");
      return chat;
    } catch (error) {
      if (error?.status) throw error;
      throw Object.assign(new Error("Unknown chat"), { status: 404 });
    }
  }

  async save(chat) {
    chat.updatedAt = new Date().toISOString();
    const pathname = this.pathFor(chat.id);
    const temporary = `${pathname}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(chat, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, pathname);
    return chat;
  }

  async remove(id) {
    await unlink(this.pathFor(id)).catch(() => {});
  }
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(Object.assign(new Error("Request body is too large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectBody(Object.assign(new Error("Request body must be JSON"), { status: 400 }));
      }
    });
    request.on("error", rejectBody);
  });
}

function presentedToken(request, url) {
  const header = String(request.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return url.searchParams.get("token");
}

function authorized(request, url, token) {
  return presentedToken(request, url) === token;
}

export const SERVICE_NAME = "grokrouter";

export function healthPayload(config, { authenticated }) {
  const identity = { service: SERVICE_NAME, version: ROUTER_VERSION, authenticated };
  if (!authenticated) return identity;
  return { ...identity, ok: true, mode: "delegation", enabled: config.enabled !== false, providers: config.providers || [], installSource: config.installSource || null, mcp: "/mcp" };
}

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_TOOLS = [
  {
    name: "delegate",
    description: "Run a task with this Bot computer's delegated provider (Codex, OpenRouter, Anthropic, or xAI) inside its workspace and return the report with the GrokRouter trailer. No Grok turn is spent.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to do, in full; the provider works in the Bot computer's workspace with shell and file tools." },
        bot: { type: "string", description: "Selection to use: a chat id from list_chats, or any key such as 'mcp' (default) whose provider/model/reasoning you set with control." },
        provider: { type: "string", enum: ["codex", "openrouter", "anthropic", "xai"], description: "Override the selection's provider for this task." },
        model: { type: "string", description: "Override the model for this task." },
        reasoning: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh"] },
        fresh: { type: "boolean", description: "Start a new provider session instead of resuming the selection's." },
      },
      required: ["task"],
    },
  },
  {
    name: "control",
    description: "Apply a GrokRouter chat control to a selection: /provider <id>, /model <id>, /reasoning <level>, /models, /router help|reset|doctor, /doctor.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, bot: { type: "string", description: "Selection key; default 'mcp'." } }, required: ["text"] },
  },
  {
    name: "status",
    description: "Show a selection's active provider, model and reasoning.",
    inputSchema: { type: "object", properties: { bot: { type: "string", description: "Selection key; default 'mcp'." } } },
  },
  {
    name: "list_chats",
    description: "List this Bot computer's GrokRouter chats (id, title, message count); a chat id can be passed as `bot` to continue that conversation's selection and provider session.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "upgrade",
    description: "Re-run this Bot computer's recorded one-line GrokRouter install in the background (same source and options, or a different ref). The chat and MCP server restart during it; poll status afterwards.",
    inputSchema: { type: "object", properties: { ref: { type: "string", description: "Tag, branch, or commit to install instead of the recorded one." } } },
  },
];

export function defaultUpgradeImpl(config) {
  return async ({ ref } = {}) => {
    const root = dirname(config.statePath || join(runtimeDirectory, "conversation-states.json"));
    const cli = join(root, "bin", "grokbot-router");
    const log = join(dirname(root), "grokbot-router-upgrade.log");
    const out = openSync(log, "a");
    const child = spawn(cli, ["upgrade", ...(ref ? ["--ref", ref] : [])], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, GROKBOT_ROUTER_CONFIG: config.configPath || process.env.GROKBOT_ROUTER_CONFIG || "" } });
    child.unref();
    return { started: true, pid: child.pid, log };
  };
}

function mcpSelectionKey(bot) {
  const value = String(bot || "mcp").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/.test(value)) throw Object.assign(new Error("bot must be a short identifier"), { code: -32602 });
  return CHAT_ID_PATTERN.test(value) ? `chat:${value}` : value.includes(":") ? value : `mcp:${value}`;
}

function mcpResult(text, structured) {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}

function mcpError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function mcpToolCall({ name, args, config, store, runDelegationImpl, runControlImpl, botStatusImpl, upgradeImpl, onProgress }) {
  const input = args && typeof args === "object" ? args : {};
  if (name === "upgrade") {
    const ref = input.ref === undefined ? "" : String(input.ref);
    if (ref && !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(ref)) return mcpError("ref must be a tag, branch, or commit");
    if (!config.installSource) return mcpError("No install source is recorded on this Bot computer; run the one-line installer there once.");
    const result = await upgradeImpl({ ref });
    return mcpResult(`Upgrade started from ${ref ? `${String(config.installSource).split("@")[0]}@${ref}` : config.installSource}; the chat and MCP server restart during it. Log: ${result.log}`, { ...result, source: config.installSource, ref: ref || String(config.installSource).split("@")[1] });
  }
  if (name === "delegate") {
    const task = String(input.task || "").trim();
    if (!task) return mcpError("task is required");
    const botId = mcpSelectionKey(input.bot);
    try {
      const result = await runDelegationImpl(
        { config, botId, task, provider: input.provider, model: input.model, reasoning: input.reasoning, fresh: Boolean(input.fresh) },
        { onProgress },
      );
      const trailer = formatDelegationTrailer(result);
      return mcpResult(`${result.text}\n\n${trailer}`, { provider: result.provider, model: result.model, reasoning: result.reasoning, steps: result.steps, durationMs: result.durationMs, trailer, bot: botId });
    } catch (error) {
      return mcpError(redactDiagnostic(error?.message || error, 1_000));
    }
  }
  if (name === "control") {
    const text = String(input.text || "").trim();
    if (!text.startsWith("/")) return mcpError("text must be a GrokRouter control starting with /");
    const result = await runControlImpl({ config, botId: mcpSelectionKey(input.bot), text }, { catalogFetch: fetch });
    return result.ok ? mcpResult(result.text, { provider: result.provider, model: result.model }) : mcpError(result.text);
  }
  if (name === "status") {
    const status = await botStatusImpl({ config, botId: mcpSelectionKey(input.bot) });
    return mcpResult(`${providerLabel(status.provider)} is active for ${status.botId}. Model: ${status.model}. Reasoning: ${status.reasoning}. GrokRouter ${ROUTER_VERSION}${config.installSource ? ` from ${config.installSource}` : ""}.`,
      { bot: status.botId, provider: status.provider, model: status.model, reasoning: status.reasoning, version: ROUTER_VERSION, installSource: config.installSource || null, providers: config.providers || [] });
  }
  if (name === "list_chats") {
    const chats = await store.list();
    return mcpResult(chats.length ? chats.map((chat) => `${chat.id}  ${chat.title}  (${chat.messages} messages, ${chat.updatedAt})`).join("\n") : "No chats yet.", { chats });
  }
  return null;
}

async function handleMcp({ request, response, body, config, store, runDelegationImpl, runControlImpl, botStatusImpl, upgradeImpl }) {
  const wantsStream = String(request.headers.accept || "").includes("text/event-stream");
  const reply = (payload, status = 200) => {
    if (wantsStream) {
      const send = sseWriter(response);
      send("message", payload);
      response.end();
      return;
    }
    json(response, status, payload);
  };
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    json(response, 400, { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } });
    return;
  }
  const { id, method, params = {} } = body;
  if (id === undefined) {
    response.writeHead(202);
    response.end();
    return;
  }
  try {
    if (method === "initialize") {
      reply({ jsonrpc: "2.0", id, result: {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "grokrouter", version: ROUTER_VERSION },
        instructions: "delegate runs a task on this Bot computer with its selected provider and returns the GrokRouter trailer; control changes a selection; list_chats and status inspect it.",
      } });
      return;
    }
    if (method === "ping") {
      reply({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      reply({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
      return;
    }
    if (method === "tools/call") {
      const name = String(params.name || "");
      let send = null;
      if (wantsStream) send = sseWriter(response);
      const progressToken = params._meta?.progressToken;
      let progressCount = 0;
      const onProgress = (line) => {
        if (send && progressToken !== undefined) {
          progressCount += 1;
          send("message", { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: progressCount, message: line } });
        }
      };
      const result = await mcpToolCall({ name, args: params.arguments, config, store, runDelegationImpl, runControlImpl, botStatusImpl, upgradeImpl, onProgress });
      const payload = result
        ? { jsonrpc: "2.0", id, result }
        : { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${name}` } };
      if (send) {
        send("message", payload);
        response.end();
      } else {
        json(response, 200, payload);
      }
      return;
    }
    reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    const payload = { jsonrpc: "2.0", id, error: { code: error?.code || -32603, message: redactDiagnostic(error?.message || error, 400) } };
    if (response.headersSent) {
      response.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      response.end();
    } else {
      json(response, 200, payload);
    }
  }
}

function sseWriter(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  return (event, payload) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
}

export function createChatServer({
  config,
  token,
  chatsDirectory = chatsDirectoryFor(config),
  runDelegationImpl = runDelegation,
  runControlImpl = runControl,
  botStatusImpl = botStatus,
  upgradeImpl = defaultUpgradeImpl(config),
  page = null,
} = {}) {
  if (!token) throw new Error("A chat token is required");
  const store = new ChatStore(chatsDirectory);
  const busy = new Set();
  const pagePromise = page ? Promise.resolve(page) : readFile(join(runtimeDirectory, "chat.html"), "utf8");

  const statusFor = async (chat) => {
    const status = await botStatusImpl({ config, botId: `chat:${chat.id}` });
    return { provider: status.provider, providerLabel: providerLabel(status.provider), model: status.model, reasoning: status.reasoning };
  };

  const handle = async (request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    const path = url.pathname;
    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(await pagePromise);
      return;
    }
    if (path === "/mcp") {
      if (!authorized(request, url, token)) {
        json(response, 401, { error: "A valid GrokRouter token is required (Authorization: Bearer …)" });
        return;
      }
      if (request.method === "POST") {
        await handleMcp({ request, response, body: await readBody(request), config, store, runDelegationImpl, runControlImpl, botStatusImpl, upgradeImpl });
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(200);
        response.end();
        return;
      }
      json(response, 405, { error: "The GrokRouter MCP endpoint accepts POST requests" });
      return;
    }
    if (!path.startsWith("/api/")) {
      json(response, 404, { error: "Not found" });
      return;
    }
    if (request.method === "GET" && path === "/api/health" && presentedToken(request, url) === null) {
      json(response, 200, healthPayload(config, { authenticated: false }));
      return;
    }
    if (!authorized(request, url, token)) {
      json(response, 401, { error: "A valid chat token is required" });
      return;
    }
    if (request.method === "GET" && path === "/api/health") {
      json(response, 200, healthPayload(config, { authenticated: true }));
      return;
    }
    if (request.method === "GET" && path === "/api/chats") {
      json(response, 200, { chats: await store.list() });
      return;
    }
    if (request.method === "POST" && path === "/api/chats") {
      const body = await readBody(request);
      const chat = await store.create(body.title);
      json(response, 201, { chat, status: await statusFor(chat) });
      return;
    }
    const match = path.match(/^\/api\/chats\/([a-z0-9]{6,32})(?:\/(messages))?$/);
    if (!match) {
      json(response, 404, { error: "Not found" });
      return;
    }
    const chat = await store.read(match[1]);
    if (request.method === "GET" && !match[2]) {
      json(response, 200, { chat, status: await statusFor(chat), busy: busy.has(chat.id) });
      return;
    }
    if (request.method === "DELETE" && !match[2]) {
      if (busy.has(chat.id)) {
        json(response, 409, { error: "This chat is still working" });
        return;
      }
      await store.remove(chat.id);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && match[2] === "messages") {
      const body = await readBody(request);
      const text = String(body.text || "").trim();
      if (!text) {
        json(response, 400, { error: "A message is required" });
        return;
      }
      if (busy.has(chat.id)) {
        json(response, 409, { error: "This chat is still working on the previous message" });
        return;
      }
      busy.add(chat.id);
      const send = sseWriter(response);
      try {
        const at = new Date().toISOString();
        if (chat.messages.length === 0) chat.title = chatTitle(text);
        chat.messages.push({ role: "user", text, at });
        await store.save(chat);
        send("message", { role: "user", text, at });
        if (text.startsWith("/")) {
          const control = await runControlImpl({ config, botId: `chat:${chat.id}`, text }, { catalogFetch: fetch });
          const entry = { role: "control", text: control.text, ok: control.ok, at: new Date().toISOString() };
          chat.messages.push(entry);
          await store.save(chat);
          send("message", entry);
        } else {
          const history = conversationHistory(chat.messages.slice(0, -1).map((entry) => ({ role: entry.role, content: entry.text })));
          const result = await runDelegationImpl(
            { config, botId: `chat:${chat.id}`, task: text, mode: "chat", history },
            { onProgress: (line) => send("progress", { line }) },
          );
          const entry = {
            role: "assistant", text: result.text, at: new Date().toISOString(),
            trailer: formatDelegationTrailer(result), provider: result.provider, model: result.model, reasoning: result.reasoning, steps: result.steps, durationMs: result.durationMs,
          };
          chat.messages.push(entry);
          await store.save(chat);
          send("message", entry);
        }
        send("done", { status: await statusFor(chat) });
      } catch (error) {
        const entry = { role: "error", text: redactDiagnostic(error?.message || error, 1_000), at: new Date().toISOString() };
        chat.messages.push(entry);
        await store.save(chat).catch(() => {});
        send("message", entry);
        send("done", { status: await statusFor(chat).catch(() => null) });
      } finally {
        busy.delete(chat.id);
        response.end();
      }
      return;
    }
    json(response, 405, { error: "Method not allowed" });
  };

  return createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      json(response, error?.status || 500, { error: redactDiagnostic(error?.message || error, 400) });
    });
  });
}

export function chatUrl(host, port, token) {
  const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${shownHost}:${port}/?token=${token}`;
}

function parseArgs(argv) {
  const options = { host: DEFAULT_HOST, port: DEFAULT_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--host") options.host = String(argv[++index] || DEFAULT_HOST);
    else if (argument === "--token-file") options.tokenFile = String(argv[++index] || "");
    else if (argument === "--url") options.urlOnly = true;
    else if (argument === "-h" || argument === "--help") options.help = true;
    else throw new Error(`Unknown option ${argument}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("--port must be 1-65535");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write([
      "GrokRouter chat server (delegation mode): chat with this Bot computer's provider without any Grok turn.",
      "",
      "  node serve.mjs [--host 127.0.0.1] [--port 7878] [--token-file PATH] [--url]",
      "",
      "Binds to 127.0.0.1 unless --host says otherwise. The token file is created on first start (0600).",
    ].join("\n") + "\n");
    return;
  }
  const config = await loadRuntimeConfig();
  const tokenFile = options.tokenFile || config.chatTokenPath || join(dirname(config.statePath || join(runtimeDirectory, "conversation-states.json")), "chat-token");
  const token = await ensureToken(tokenFile);
  if (options.urlOnly) {
    process.stdout.write(`${chatUrl(options.host, options.port, token)}\n`);
    return;
  }
  const server = createChatServer({ config, token });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, options.host, () => resolveListen());
  });
  process.stdout.write(`GrokRouter chat ${ROUTER_VERSION} listening on ${chatUrl(options.host, options.port, token)}\n`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${redactDiagnostic(error?.message || error, 600)}\n`);
    process.exitCode = 1;
  });
}
