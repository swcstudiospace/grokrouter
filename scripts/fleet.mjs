#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
export const DEFAULT_TAG = "tag:grokrouter";
export const DEFAULT_PREFIX = "grokrouter-";

export const SERVICE_MARKER = "grokrouter";

function peerNodes(status) {
  const candidates = [status?.Self, ...Object.values(status?.Peer || {})].filter(Boolean);
  return candidates.map((peer) => {
    const dns = String(peer.DNSName || "").replace(/\.$/, "");
    const host = String(peer.HostName || dns.split(".")[0] || "");
    const tags = Array.isArray(peer.Tags) ? peer.Tags : [];
    return { dns, host, tags, os: String(peer.OS || ""), online: peer.Online !== false, ips: Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : [] };
  }).filter((peer) => peer.dns);
}

function displayName(host, prefix) {
  return host.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "") || host;
}

export function fleetNodes(status, { tag = DEFAULT_TAG, prefix = DEFAULT_PREFIX, only = [] } = {}) {
  const nodes = [];
  for (const peer of peerNodes(status)) {
    const matches = (tag && peer.tags.includes(tag)) || (prefix && peer.host.startsWith(prefix));
    if (!matches) continue;
    const name = displayName(peer.host, prefix);
    if (only.length && !only.includes(name) && !only.includes(peer.host)) continue;
    nodes.push({ name, host: peer.host, dns: peer.dns, online: peer.online, ips: peer.ips });
  }
  return nodes.sort((a, b) => a.name.localeCompare(b.name));
}

export function probeCandidates(status, { tag = DEFAULT_TAG, prefix = DEFAULT_PREFIX, only = [] } = {}) {
  const matchedDns = new Set(fleetNodes(status, { tag, prefix, only: [] }).map((node) => node.dns));
  const extras = [];
  for (const peer of peerNodes(status)) {
    if (matchedDns.has(peer.dns) || !peer.online) continue;
    if (peer.os && peer.os !== "linux") continue;
    const name = displayName(peer.host, prefix);
    if (only.length && !only.includes(name) && !only.includes(peer.host)) continue;
    extras.push({ name, host: peer.host, dns: peer.dns, online: true, ips: peer.ips });
  }
  return extras;
}

export async function tailscaleStatus({ tailscaleBinary = "tailscale" } = {}) {
  const { stdout } = await execFileAsync(tailscaleBinary, ["status", "--json"], { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export class BotClient {
  constructor(node, { token, fetchImpl = fetch, insecureHttp = false } = {}) {
    this.node = node;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.bases = insecureHttp ? [`http://${node.dns}`] : [`https://${node.dns}`, `http://${node.dns}`];
    this.base = null;
    this.nextId = 1;
  }

  async resolveBase() {
    if (this.base) return this.base;
    let lastError;
    for (const base of this.bases) {
      try {
        const response = await this.fetchImpl(`${base}/api/health`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(8_000) });
        if (response.status === 401) throw new Error(`${this.node.name}: the token was rejected`);
        if (response.ok) {
          this.base = base;
          this.health = await response.json();
          return base;
        }
        lastError = new Error(`${base} answered ${response.status}`);
      } catch (error) {
        lastError = error;
        if (/token was rejected/.test(String(error?.message))) throw error;
      }
    }
    throw new Error(`${this.node.name} is not reachable over the tailnet (${lastError?.message || "no answer"}); is grokbot-router tailscale serve running there?`);
  }

  async isGrokRouter({ timeoutMilliseconds = 4_000 } = {}) {
    for (const base of this.bases) {
      let body;
      try {
        const response = await this.fetchImpl(`${base}/api/health`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(timeoutMilliseconds) });
        if (!response.ok) continue;
        body = await response.json();
      } catch {
        continue;
      }
      if (body && (body.service === SERVICE_MARKER || body.mode === "delegation")) {
        this.base = base;
        this.health = body;
        return true;
      }
      return false;
    }
    return false;
  }

  async rpc(method, params = {}, { timeoutMilliseconds = 30 * 60_000 } = {}) {
    const base = await this.resolveBase();
    const id = this.nextId++;
    const response = await this.fetchImpl(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    const payload = await response.json();
    if (payload.error) throw new Error(`${this.node.name}: ${payload.error.message}`);
    return payload.result;
  }

  async tool(name, args = {}, options) {
    const result = await this.rpc("tools/call", { name, arguments: args }, options);
    const text = (result?.content || []).map((part) => part.text || "").join("\n");
    if (result?.isError) throw new Error(`${this.node.name}: ${text}`);
    return { text, structured: result?.structuredContent || null };
  }
}

export async function discover({ token, tag, prefix, only, fetchImpl, tailscaleBinary, status, probe } = {}) {
  const resolved = status || await tailscaleStatus({ tailscaleBinary });
  const matched = fleetNodes(resolved, { tag, prefix, only });
  const shouldProbe = probe === undefined ? !status : probe;
  let nodes = matched;
  if (shouldProbe) {
    const extras = probeCandidates(resolved, { tag, prefix, only });
    const confirmed = await Promise.all(extras.map(async (node) => {
      const client = new BotClient(node, { token, fetchImpl });
      return (await client.isGrokRouter().catch(() => false)) ? { node, client } : null;
    }));
    const found = confirmed.filter(Boolean);
    nodes = [...matched.map((node) => ({ node, client: new BotClient(node, { token, fetchImpl }) })), ...found]
      .sort((a, b) => a.node.name.localeCompare(b.node.name));
    return nodes;
  }
  return nodes.map((node) => ({ node, client: new BotClient(node, { token, fetchImpl }) }));
}

function line(text) {
  process.stdout.write(`${text}\n`);
}

async function forEachBot(bots, worker) {
  const results = await Promise.allSettled(bots.map(({ node, client }) => worker(node, client)));
  let failures = 0;
  results.forEach((result, index) => {
    const { node } = bots[index];
    if (result.status === "fulfilled") line(`${node.name}: ${result.value}`);
    else {
      failures += 1;
      line(`${node.name}: ERROR ${result.reason?.message || result.reason}`);
    }
  });
  return failures;
}

const FLEET_TOOLS = [
  { name: "bots", description: "List the Bot computers on the tailnet that run GrokRouter, with reachability, version and active selection.", inputSchema: { type: "object", properties: {} } },
  { name: "delegate", description: "Run a task on one Bot computer with its selected provider (zero Grok usage) and return the report with the GrokRouter trailer.", inputSchema: { type: "object", properties: { bot: { type: "string", description: "Bot name from bots (for example ship-desk)." }, task: { type: "string" }, selection: { type: "string", description: "Selection key on that Bot; default is this fleet's caller name." }, provider: { type: "string", enum: ["codex", "openrouter", "anthropic", "xai"] }, model: { type: "string" }, reasoning: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh"] }, fresh: { type: "boolean" } }, required: ["bot", "task"] } },
  { name: "control", description: "Apply a GrokRouter control (/provider, /model, /reasoning, /router …) to a selection on one Bot computer.", inputSchema: { type: "object", properties: { bot: { type: "string" }, text: { type: "string" }, selection: { type: "string" } }, required: ["bot", "text"] } },
  { name: "status", description: "Show one Bot computer's active provider, model, reasoning and GrokRouter version.", inputSchema: { type: "object", properties: { bot: { type: "string" }, selection: { type: "string" } }, required: ["bot"] } },
  { name: "upgrade", description: "Re-run the recorded one-line GrokRouter install on one Bot computer, or on every reachable one when bot is omitted.", inputSchema: { type: "object", properties: { bot: { type: "string" }, ref: { type: "string" } } } },
];

export async function fleetToolCall(name, args, { token, tag, prefix, fetchImpl, tailscaleBinary, caller = "fleet", status, probe, discovered } = {}) {
  const input = args && typeof args === "object" ? args : {};
  const bots = discovered || await discover({ token, tag, prefix, fetchImpl, tailscaleBinary, status, probe });
  const pick = () => {
    const bot = bots.find(({ node }) => node.name === input.bot || node.host === input.bot);
    if (!bot) throw new Error(`Unknown bot ${input.bot}; known: ${bots.map(({ node }) => node.name).join(", ") || "none"}`);
    return bot;
  };
  const selection = input.selection || caller;
  if (name === "bots") {
    const rows = await Promise.all(bots.map(async ({ node, client }) => {
      try {
        const { structured } = await client.tool("status", { bot: selection }, { timeoutMilliseconds: 20_000 });
        return { name: node.name, dns: node.dns, reachable: true, version: structured?.version, provider: structured?.provider, model: structured?.model, reasoning: structured?.reasoning, providers: structured?.providers || [] };
      } catch (error) {
        return { name: node.name, dns: node.dns, reachable: false, error: String(error?.message || error) };
      }
    }));
    return { content: [{ type: "text", text: rows.length ? rows.map((row) => row.reachable ? `${row.name}: GrokRouter ${row.version} · ${row.provider} · ${row.model} · ${row.reasoning}` : `${row.name}: unreachable (${row.error})`).join("\n") : "No GrokRouter Bot computers found on the tailnet." }], structuredContent: { bots: rows } };
  }
  if (name === "delegate") {
    const { client } = pick();
    const { text, structured } = await client.tool("delegate", { task: input.task, bot: selection, provider: input.provider, model: input.model, reasoning: input.reasoning, fresh: input.fresh });
    return { content: [{ type: "text", text }], structuredContent: structured };
  }
  if (name === "control") {
    const { client } = pick();
    const { text, structured } = await client.tool("control", { text: input.text, bot: selection }, { timeoutMilliseconds: 60_000 });
    return { content: [{ type: "text", text }], structuredContent: structured };
  }
  if (name === "status") {
    const { client } = pick();
    const { text, structured } = await client.tool("status", { bot: selection }, { timeoutMilliseconds: 20_000 });
    return { content: [{ type: "text", text }], structuredContent: structured };
  }
  if (name === "upgrade") {
    const targets = input.bot ? [pick()] : bots;
    const rows = await Promise.all(targets.map(async ({ node, client }) => {
      try {
        const { text } = await client.tool("upgrade", input.ref ? { ref: input.ref } : {}, { timeoutMilliseconds: 60_000 });
        return `${node.name}: ${text}`;
      } catch (error) {
        return `${node.name}: ERROR ${error?.message || error}`;
      }
    }));
    return { content: [{ type: "text", text: rows.join("\n") || "No Bot computers to upgrade." }] };
  }
  return null;
}

async function serveStdioMcp(options) {
  const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const raw of reader) {
    if (!raw.trim()) continue;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }
    const { id, method, params = {} } = message;
    if (id === undefined) continue;
    try {
      if (method === "initialize") {
        write({ jsonrpc: "2.0", id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "grokrouter-fleet", version: "1" }, instructions: "bots lists the GrokRouter Bot computers on this tailnet; delegate runs a task on one of them with zero Grok usage." } });
      } else if (method === "ping") {
        write({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        write({ jsonrpc: "2.0", id, result: { tools: FLEET_TOOLS } });
      } else if (method === "tools/call") {
        const result = await fleetToolCall(String(params.name || ""), params.arguments, options).catch((error) => ({ content: [{ type: "text", text: String(error?.message || error) }], isError: true }));
        write(result ? { jsonrpc: "2.0", id, result } : { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params.name}` } });
      } else {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (error) {
      write({ jsonrpc: "2.0", id, error: { code: -32603, message: String(error?.message || error) } });
    }
  }
}

function usage() {
  return [
    "GrokRouter fleet: talk to every GrokRouter Bot computer on your tailnet from one place.",
    "",
    "Usage: node scripts/fleet.mjs <command> [options]",
    "  bots                              List Bot computers (tag:grokrouter or grokrouter-* nodes, plus any online node",
    "                                    that answers as a GrokRouter Bot) with version and selection",
    "  status [--only a,b]               Active provider/model/reasoning on each Bot",
    "  delegate --bot NAME --task TEXT   Run a task on one Bot and print its report",
    "  control --bot NAME --text \"/model …\"",
    "  upgrade [--only a,b] [--ref REF]  Re-run the recorded one-line install on each Bot",
    "  mcp                               Serve these as an MCP server over stdio (for Claude Code, Hermes, …)",
    "",
    "Options: --token TOKEN (or GROKROUTER_CHAT_TOKEN), --tag tag:grokrouter, --prefix grokrouter-, --selection KEY (default fleet),",
    "         --tailscale PATH (the tailscale binary on this machine), --no-probe (only tagged/prefixed nodes, skip service probe).",
    "Requires this machine to be on the same tailnet, with the shared chat token used at install time.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "bots";
  const options = { token: process.env.GROKROUTER_CHAT_TOKEN || "", tag: DEFAULT_TAG, prefix: DEFAULT_PREFIX, only: [], caller: "fleet" };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => String(argv[++index] ?? "");
    if (argument === "--token") options.token = value();
    else if (argument === "--tag") options.tag = value();
    else if (argument === "--prefix") options.prefix = value();
    else if (argument === "--only") options.only = value().split(",").map((item) => item.trim()).filter(Boolean);
    else if (argument === "--bot") options.bot = value();
    else if (argument === "--task") options.task = value();
    else if (argument === "--text") options.text = value();
    else if (argument === "--ref") options.ref = value();
    else if (argument === "--selection") options.caller = value();
    else if (argument === "--tailscale") options.tailscaleBinary = value();
    else if (argument === "--probe") options.probe = true;
    else if (argument === "--no-probe") options.probe = false;
    else if (argument === "-h" || argument === "--help") {
      process.stdout.write(`${usage()}\n`);
      return;
    } else throw new Error(`Unknown option ${argument}\n\n${usage()}`);
  }
  if (command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.token) throw new Error("A chat token is required: --token or GROKROUTER_CHAT_TOKEN");
  if (command === "mcp") {
    await serveStdioMcp(options);
    return;
  }
  const bots = await discover(options);
  if (!bots.length) {
    line("No GrokRouter Bot computers found on this tailnet.");
    process.exitCode = 1;
    return;
  }
  if (command === "bots") {
    const result = await fleetToolCall("bots", {}, { ...options, discovered: bots });
    line(result.content[0].text);
    return;
  }
  if (command === "status") {
    process.exitCode = await forEachBot(bots, async (_node, client) => (await client.tool("status", { bot: options.caller }, { timeoutMilliseconds: 20_000 })).text) ? 1 : 0;
    return;
  }
  if (command === "upgrade") {
    process.exitCode = await forEachBot(bots, async (_node, client) => (await client.tool("upgrade", options.ref ? { ref: options.ref } : {}, { timeoutMilliseconds: 60_000 })).text) ? 1 : 0;
    return;
  }
  if (command === "delegate" || command === "control") {
    if (!options.bot) throw new Error(`${command} needs --bot NAME`);
    const result = await fleetToolCall(command, command === "delegate" ? { bot: options.bot, task: options.task } : { bot: options.bot, text: options.text }, { ...options, discovered: bots });
    line(result.content[0].text);
    return;
  }
  throw new Error(`Unknown command ${command}\n\n${usage()}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
