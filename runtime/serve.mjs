import { randomBytes } from "node:crypto";
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

function authorized(request, url, token) {
  const header = String(request.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ") && header.slice(7).trim() === token) return true;
  return url.searchParams.get("token") === token;
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
    if (!path.startsWith("/api/")) {
      json(response, 404, { error: "Not found" });
      return;
    }
    if (!authorized(request, url, token)) {
      json(response, 401, { error: "A valid chat token is required" });
      return;
    }
    if (request.method === "GET" && path === "/api/health") {
      json(response, 200, { ok: true, version: ROUTER_VERSION, mode: "delegation", enabled: config.enabled !== false, providers: config.providers || [] });
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
