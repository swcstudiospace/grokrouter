#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(scriptDirectory, "..");
export const NATIVE_COMMAND_NAMES = Object.freeze(["provider", "models", "model", "reasoning", "router", "doctor", "route"]);
export const CDP_PORT = 19222;
const MAC_APP_PATH = "/Applications/Grok Bot.app";
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

export function nativeCommandDefinitions(skillsDirectory = join(PROJECT_ROOT, "skills"), names = NATIVE_COMMAND_NAMES) {
  return names.map((name) => {
    const markdown = readFileSync(join(skillsDirectory, name, "SKILL.md"), "utf8");
    const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!frontmatter) throw new Error(`Native command /${name} has invalid frontmatter.`);
    const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    const body = frontmatter[2].trim();
    if (!description || !body.includes(`GROKROUTER_NATIVE_CONTROL: ${name.toUpperCase()}`)) {
      throw new Error(`Native command /${name} is missing its ownership marker.`);
    }
    return { name, description, body, markdown };
  });
}

export function registrationExpression(definitions, operation, script = readFileSync(join(PROJECT_ROOT, "installer", "native-workflow-registration.js"), "utf8")) {
  if (!["sync", "remove"].includes(operation)) throw new Error(`Unknown registration operation: ${operation}`);
  let expression = script;
  for (const [marker, value] of [
    ["__GROKROUTER_NATIVE_SKILLS__", definitions],
    ["__GROKROUTER_NATIVE_OPERATION__", operation],
  ]) {
    if (expression.split(marker).length !== 2) throw new Error(`Native command bridge marker ${marker} is invalid.`);
    expression = expression.replace(marker, JSON.stringify(value));
  }
  return expression;
}

export function summarizeStats(stats, operation) {
  const lines = [];
  if (operation === "remove") {
    lines.push(`Removed ${stats.removed} GrokRouter command entries from Grok Bot's shared workflow library.`);
  } else {
    lines.push(`Verified ${stats.installed + stats.updated + (stats.unchanged || 0)} GrokRouter commands for ${stats.bots} Bots and channels (${stats.installed} installed, ${stats.updated} updated, ${stats.unchanged || 0} unchanged).`);
    if (stats.removed) lines.push(`Removed ${stats.removed} duplicate command entries left by an earlier build.`);
  }
  if (stats.conflicts) lines.push(`${stats.conflicts} user-owned slash commands were preserved because their names conflict.`);
  return lines.join("\n");
}

async function requestJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Local diagnostic endpoint answered ${response.status}.`);
  return response.json();
}

async function browserWebSocketURL() {
  const value = await requestJSON(`http://127.0.0.1:${CDP_PORT}/json/version`);
  if (typeof value.webSocketDebuggerUrl !== "string") throw new Error("Grok Bot's diagnostic endpoint is unavailable.");
  return value.webSocketDebuggerUrl;
}

async function endpointOpen() {
  return browserWebSocketURL().then(() => true).catch(() => false);
}

class CDPClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextID = 1;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener("open", () => resolveReady(), { once: true });
      this.socket.addEventListener("error", () => rejectReady(new Error("Grok Bot's local diagnostic connection could not be opened.")), { once: true });
    });
    this.socket.addEventListener("message", (event) => this.route(event.data));
    this.socket.addEventListener("close", () => this.rejectAll(new Error("Grok Bot closed its local diagnostic connection.")));
  }

  route(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (Number.isInteger(message.id) && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async call(method, params = {}, sessionId = undefined, timeoutMilliseconds = 30_000) {
    await this.ready;
    const id = this.nextID++;
    const response = new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`DevTools timed out while running ${method}.`));
      }, timeoutMilliseconds);
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
    });
    this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    const message = await response;
    if (message.error) throw new Error(`DevTools error: ${message.error.message || JSON.stringify(message.error)}`);
    return message.result || {};
  }

  close() {
    this.socket.close();
  }
}

async function mainPageSession(client) {
  const { targetInfos = [] } = await client.call("Target.getTargets");
  const page = targetInfos.find((item) => item.type === "page" && String(item.url || "").includes("/renderer/index.html"));
  if (!page) throw new Error("Grok Bot's main window was not found. Open Grok Bot, select a Bot, and retry.");
  const { sessionId } = await client.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  if (!sessionId) throw new Error("Could not attach to Grok Bot's main window.");
  return sessionId;
}

async function evaluate(client, sessionId, expression, timeoutMilliseconds) {
  const response = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMilliseconds);
  if (response.exceptionDetails) {
    const text = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "unknown error";
    throw new Error(`Grok Bot rejected the registration: ${String(text).split("\n")[0].slice(0, 300)}`);
  }
  return response;
}

function macGrokRunning() {
  return execFileAsync("/usr/bin/pgrep", ["-x", "Grok Bot"]).then(() => true).catch(() => false);
}

async function quitGrokMac() {
  if (!(await macGrokRunning())) return;
  await execFileAsync("/usr/bin/osascript", ["-e", 'tell application "Grok Bot" to quit']).catch(() => {});
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!(await macGrokRunning())) return;
    await delay(250);
  }
  await execFileAsync("/usr/bin/pkill", ["-x", "Grok Bot"]).catch(() => {});
  await delay(500);
}

async function launchGrokMac(diagnostics) {
  const args = ["-na", MAC_APP_PATH];
  if (diagnostics) args.push("--args", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${CDP_PORT}`);
  await execFileAsync("/usr/bin/open", args);
}

function windowsGrokPaths() {
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
    process.env.LOCALAPPDATA,
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ].filter(Boolean);
  return [...new Set(roots.flatMap((root) => [join(root, "Grok Bot", "Grok Bot.exe"), join(root, "GrokBot", "Grok Bot.exe")]))];
}

async function quitGrokWindows() {
  await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "Get-Process -Name 'Grok Bot' -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }"], { windowsHide: true }).catch(() => {});
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { stdout = "" } = await execFileAsync("tasklist.exe", ["/FI", "IMAGENAME eq Grok Bot.exe", "/NH"], { windowsHide: true }).catch(() => ({ stdout: "" }));
    if (!stdout.toLowerCase().includes("grok bot.exe")) return;
    await delay(125);
  }
  await execFileAsync("taskkill.exe", ["/F", "/T", "/IM", "Grok Bot.exe"], { windowsHide: true }).catch(() => {});
  await delay(500);
}

async function launchGrokWindows(diagnostics) {
  const executable = windowsGrokPaths().find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Install the official Grok Bot app first.");
  const args = diagnostics ? ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${CDP_PORT}`] : [];
  const child = spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}

function platformDriver() {
  if (process.platform === "darwin") {
    if (!existsSync(MAC_APP_PATH)) throw new Error("Install the official Grok Bot app in /Applications first.");
    return { quit: quitGrokMac, launch: launchGrokMac };
  }
  if (process.platform === "win32") return { quit: quitGrokWindows, launch: launchGrokWindows };
  throw new Error("Native command registration runs on the Mac or Windows PC where the Grok Bot desktop app is installed.");
}

export async function registerNativeCommands({ operation = "sync", skillsDirectory, log = () => {} } = {}) {
  const definitions = nativeCommandDefinitions(skillsDirectory);
  const expression = registrationExpression(definitions, operation);
  const driver = platformDriver();
  let relaunched = false;
  if (!(await endpointOpen())) {
    log("Restarting Grok Bot with a temporary local diagnostic port (127.0.0.1 only)…");
    await driver.quit();
    if (await endpointOpen()) throw new Error(`Local port ${CDP_PORT} is already in use. Close the application using it and retry.`);
    await driver.launch(true);
    relaunched = true;
    let ready = false;
    for (let attempt = 0; attempt < 160 && !ready; attempt += 1) {
      ready = await endpointOpen();
      if (!ready) await delay(250);
    }
    if (!ready) throw new Error("Grok Bot's local diagnostic connection did not become ready.");
  }
  const client = new CDPClient(await browserWebSocketURL());
  let stats;
  try {
    let sessionId;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        sessionId = await mainPageSession(client);
        break;
      } catch (error) {
        if (attempt === 119) throw error;
        await delay(500);
      }
    }
    log(`Registering ${definitions.length} GrokRouter commands in Grok Bot's shared workflow library…`);
    const response = await evaluate(client, sessionId, expression, 240_000);
    const encoded = response.result?.value;
    if (typeof encoded !== "string") throw new Error("Grok Bot did not return a native command registration receipt.");
    stats = JSON.parse(encoded);
  } finally {
    client.close();
    if (relaunched) {
      log("Closing the temporary diagnostic port and reopening Grok Bot normally…");
      await driver.quit();
      await driver.launch(false).catch(() => log("Grok Bot did not reopen automatically. Open it normally."));
    }
  }
  return stats;
}

function usage() {
  return [
    "Register GrokRouter's native slash commands in the Grok Bot desktop app (delegation mode, Grok Bot 0.63.0+).",
    "",
    "Usage: node scripts/register-native-commands.mjs [--remove] [--skills DIR] [--print]",
    "  --remove       Remove GrokRouter's commands from the shared workflow library",
    "  --skills DIR   Read SKILL.md files from DIR instead of the repository's skills/",
    "  --print        Print the command definitions and exit without touching Grok Bot",
    "",
    "Run this on the Mac or Windows PC that runs Grok Bot, after the one-line Bot terminal install.",
    "It restarts Grok Bot once with a local-only diagnostic port and reopens it normally afterwards.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let operation = "sync";
  let skillsDirectory;
  let print = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--remove") operation = "remove";
    else if (argument === "--skills") skillsDirectory = resolve(argv[++index] || "");
    else if (argument === "--print") print = true;
    else if (argument === "-h" || argument === "--help") {
      process.stdout.write(`${usage()}\n`);
      return;
    } else throw new Error(`Unknown option ${argument}\n\n${usage()}`);
  }
  if (print) {
    for (const definition of nativeCommandDefinitions(skillsDirectory)) {
      process.stdout.write(`/${definition.name}: ${definition.description}\n`);
    }
    return;
  }
  const stats = await registerNativeCommands({ operation, skillsDirectory, log: (line) => process.stdout.write(`${line}\n`) });
  process.stdout.write(`${summarizeStats(stats, operation)}\nGROKBOT_ROUTER_COMMANDS_OK\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
