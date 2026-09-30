import { execFile, spawn } from "node:child_process";
import { createWriteStream, openSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadRuntimeConfig, redactDiagnostic } from "./run-provider.mjs";
import { DEFAULT_PORT, chatUrl, ensureToken } from "./serve.mjs";

const execFileAsync = promisify(execFile);
const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
export const TAILSCALE_INDEX_URL = "https://pkgs.tailscale.com/stable/?mode=json";
export const TAILSCALE_DOWNLOAD_BASE = "https://pkgs.tailscale.com/stable/";
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

export function tailscaleArch(machine = process.arch) {
  return { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" }[machine] || null;
}

export async function resolveRelease({ fetchImpl = fetch, arch = tailscaleArch() } = {}) {
  if (!arch) throw new Error(`Tailscale has no static build for ${process.arch}`);
  const response = await fetchImpl(TAILSCALE_INDEX_URL, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Tailscale's package index answered ${response.status}`);
  const index = await response.json();
  const tarball = index?.Tarballs?.[arch];
  const version = String(index?.TarballsVersion || index?.Version || "");
  if (typeof tarball !== "string" || !/^tailscale_[\w.-]+\.tgz$/.test(tarball) || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Tailscale's package index did not name a usable tarball");
  }
  return { version, tarball, url: `${TAILSCALE_DOWNLOAD_BASE}${tarball}`, directory: tarball.replace(/\.tgz$/, "") };
}

export function tailnetPaths(root) {
  const base = join(root, "tailscale");
  return {
    base,
    bin: join(base, "bin"),
    tailscale: join(base, "bin", "tailscale"),
    tailscaled: join(base, "bin", "tailscaled"),
    state: join(base, "state"),
    socket: join(base, "tailscaled.sock"),
    pid: join(base, "tailscaled.pid"),
    log: join(base, "tailscaled.log"),
    version: join(base, "VERSION"),
  };
}

export function loginUrlFrom(output) {
  return String(output || "").match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0] || null;
}

export function nodeName(status) {
  const dns = String(status?.Self?.DNSName || "").replace(/\.$/, "");
  return dns || null;
}

export function defaultHostname(machine = hostname()) {
  const suffix = String(machine).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").at(-1) || "bot";
  return `grokrouter-${suffix}`.slice(0, 63);
}

export function serveUrlFor(status, { https = true, port = https ? 443 : 80, token } = {}) {
  const name = nodeName(status);
  if (!name) return null;
  const origin = `${https ? "https" : "http"}://${name}${(https && port === 443) || (!https && port === 80) ? "" : `:${port}`}`;
  return token ? `${origin}/?token=${token}` : origin;
}

export async function installTailscale({ root, fetchImpl = fetch, log = () => {}, force = false } = {}) {
  const paths = tailnetPaths(root);
  const release = await resolveRelease({ fetchImpl });
  const installed = await readFile(paths.version, "utf8").then((text) => text.trim()).catch(() => "");
  if (!force && installed === release.version && (await stat(paths.tailscale).catch(() => null)) && (await stat(paths.tailscaled).catch(() => null))) {
    return { ...release, reused: true };
  }
  log(`Downloading Tailscale ${release.version} (static build, user-space networking)…`);
  await mkdir(paths.bin, { recursive: true });
  const archive = join(paths.base, release.tarball);
  const response = await fetchImpl(release.url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Tailscale download answered ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  const extracted = join(paths.base, "extract");
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  await execFileAsync("tar", ["-xzf", archive, "-C", extracted]);
  for (const name of ["tailscale", "tailscaled"]) {
    const source = join(extracted, release.directory, name);
    await stat(source);
    await execFileAsync("cp", ["-f", source, join(paths.bin, name)]);
    await chmod(join(paths.bin, name), 0o755);
  }
  await rm(extracted, { recursive: true, force: true });
  await rm(archive, { force: true });
  await writeFile(paths.version, `${release.version}\n`);
  return { ...release, reused: false };
}

async function daemonPid(paths) {
  const pid = Number((await readFile(paths.pid, "utf8").catch(() => "")).trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export async function tailscaleCommand(paths, args, { timeoutMilliseconds = 60_000 } = {}) {
  const { stdout, stderr } = await execFileAsync(paths.tailscale, [`--socket=${paths.socket}`, ...args], { timeout: timeoutMilliseconds, maxBuffer: 4 * 1024 * 1024 });
  return `${stdout}${stderr}`;
}

export async function statusJson(paths) {
  try {
    return JSON.parse(await tailscaleCommand(paths, ["status", "--json"], { timeoutMilliseconds: 15_000 }));
  } catch {
    return null;
  }
}

export async function startDaemon({ root, log = () => {} } = {}) {
  const paths = tailnetPaths(root);
  if (await daemonPid(paths)) return { started: false, pid: await daemonPid(paths) };
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const out = openSync(paths.log, "a");
  const child = spawn(paths.tailscaled, [
    "--tun=userspace-networking",
    `--statedir=${paths.state}`,
    `--socket=${paths.socket}`,
    "--port=0",
  ], { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  await writeFile(paths.pid, `${child.pid}\n`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await statusJson(paths)) return { started: true, pid: child.pid };
    await delay(250);
  }
  throw new Error(`tailscaled did not answer on its socket; see ${paths.log}`);
}

export async function stopDaemon({ root } = {}) {
  const paths = tailnetPaths(root);
  const pid = await daemonPid(paths);
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!(await daemonPid(paths))) break;
      await delay(100);
    }
  }
  await rm(paths.pid, { force: true });
  return { stopped: Boolean(pid) };
}

export function validTags(tags) {
  const list = String(tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  for (const tag of list) {
    if (!/^tag:[a-z0-9][a-z0-9-]{0,62}$/.test(tag)) throw new Error(`--tags must be comma-separated tag:name entries; got ${tag}`);
  }
  return list;
}

export async function bringUp({ root, hostname: name = defaultHostname(), authKey = "", tags = "", log = () => {} } = {}) {
  const paths = tailnetPaths(root);
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error("--hostname must be a DNS label: lowercase letters, digits and hyphens");
  const args = ["up", `--hostname=${name}`, "--timeout=25s"];
  const tagList = validTags(tags);
  if (tagList.length) args.push(`--advertise-tags=${tagList.join(",")}`);
  if (authKey) args.push(`--auth-key=${authKey}`);
  let output = "";
  try {
    output = await tailscaleCommand(paths, args, { timeoutMilliseconds: 40_000 });
  } catch (error) {
    output = `${error?.stdout || ""}${error?.stderr || ""}${error?.message || ""}`;
  }
  const status = await statusJson(paths);
  const loginUrl = loginUrlFrom(output);
  const running = status?.BackendState === "Running";
  if (!running && !loginUrl) throw new Error(`tailscale up did not finish: ${redactDiagnostic(output.replace(/--auth-key=\S+/g, "--auth-key=[REDACTED]"), 400)}`);
  return { running, loginUrl, node: nodeName(status), hostname: name };
}

export async function publishChat({ root, port = DEFAULT_PORT, log = () => {} } = {}) {
  const paths = tailnetPaths(root);
  const status = await statusJson(paths);
  if (status?.BackendState !== "Running") throw new Error("This Bot computer is not connected to a tailnet yet; run grokbot-router tailscale up first");
  try {
    await tailscaleCommand(paths, ["serve", "--bg", "--yes", `--https=443`, String(port)]);
    return { https: true, url: serveUrlFor(status, { https: true }) };
  } catch (error) {
    log(`HTTPS serve is unavailable (${redactDiagnostic(error?.stderr || error?.message || error, 200).trim()}); publishing plain HTTP on the tailnet instead.`);
    await tailscaleCommand(paths, ["serve", "--bg", "--yes", "--http=80", String(port)]);
    return { https: false, url: serveUrlFor(status, { https: false }) };
  }
}

export async function tailnetStatus({ root } = {}) {
  const paths = tailnetPaths(root);
  const installed = await readFile(paths.version, "utf8").then((text) => text.trim()).catch(() => "");
  const pid = await daemonPid(paths);
  const status = pid ? await statusJson(paths) : null;
  let serve = "";
  if (status?.BackendState === "Running") serve = await tailscaleCommand(paths, ["serve", "status"], { timeoutMilliseconds: 15_000 }).catch(() => "");
  return {
    installed: installed || null,
    daemonPid: pid,
    backendState: status?.BackendState || (pid ? "Unknown" : "Stopped"),
    node: nodeName(status),
    ips: Array.isArray(status?.TailscaleIPs) ? status.TailscaleIPs : [],
    serve: serve.trim(),
  };
}

function usage() {
  return [
    "GrokRouter tailnet helper: put this Bot computer on your Tailscale network and publish the zero-Grok chat and MCP endpoint to it.",
    "",
    "  node tailnet.mjs up [--hostname NAME] [--auth-key KEY] [--tags tag:a,tag:b]",
    "                                                          Install Tailscale (user-space), start it, join the tailnet, publish the chat",
    "  node tailnet.mjs start                                  Start tailscaled again (used by the desktop autostart entry)",
    "  node tailnet.mjs serve                                  (Re)publish the chat server on the tailnet",
    "  node tailnet.mjs status                                 Show the node name, IPs and serve configuration",
    "  node tailnet.mjs stop                                   Stop tailscaled (the node stays registered)",
    "",
    "Without --auth-key (or GROKROUTER_TAILSCALE_AUTH_KEY), `up` prints a login link to approve once in a browser. A reusable,",
    "pre-authorized key with --tags (or GROKROUTER_TAILSCALE_TAGS) joins unattended; the key is never written to a log.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "status";
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--hostname") options.hostname = String(argv[++index] || "");
    else if (argument === "--auth-key") options.authKey = String(argv[++index] || "");
    else if (argument === "--tags") options.tags = String(argv[++index] || "");
    else if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--force") options.force = true;
    else if (argument === "-h" || argument === "--help") {
      process.stdout.write(`${usage()}\n`);
      return;
    } else throw new Error(`Unknown option ${argument}\n\n${usage()}`);
  }
  const config = await loadRuntimeConfig();
  const root = dirname(config.statePath || join(runtimeDirectory, "conversation-states.json"));
  const log = (line) => process.stdout.write(`${line}\n`);
  const port = Number.isInteger(options.port) && options.port > 0 ? options.port : Number(process.env.ROUTER_CHAT_PORT) || DEFAULT_PORT;
  if (command === "up") {
    const release = await installTailscale({ root, log, force: Boolean(options.force) });
    log(release.reused ? `Tailscale ${release.version} is already installed.` : `Installed Tailscale ${release.version}.`);
    const daemon = await startDaemon({ root, log });
    log(daemon.started ? "tailscaled started (user-space networking, this Bot computer only)." : "tailscaled is already running.");
    const up = await bringUp({ root, hostname: options.hostname || defaultHostname(), authKey: options.authKey || process.env.GROKROUTER_TAILSCALE_AUTH_KEY || "", tags: options.tags || process.env.GROKROUTER_TAILSCALE_TAGS || "", log });
    if (!up.running) {
      log(`Approve this Bot computer on your tailnet, then run grokbot-router tailscale serve:\n\n  ${up.loginUrl}\n`);
      log(`Node name after approval: ${up.hostname}`);
      return;
    }
    const published = await publishChat({ root, port, log });
    const token = await ensureToken(config.chatTokenPath || join(root, "chat-token"));
    log(`Connected as ${up.node}.`);
    log(`Zero-Grok chat on your tailnet: ${published.url}/?token=${token}`);
    log(`MCP endpoint for your agents: ${published.url}/mcp (Authorization: Bearer <the same token>)`);
    return;
  }
  if (command === "start") {
    const daemon = await startDaemon({ root, log });
    log(daemon.started ? "tailscaled started." : "tailscaled is already running.");
    return;
  }
  if (command === "serve") {
    await startDaemon({ root, log });
    const published = await publishChat({ root, port, log });
    const token = await ensureToken(config.chatTokenPath || join(root, "chat-token"));
    log(`Zero-Grok chat on your tailnet: ${published.url}/?token=${token}`);
    log(`MCP endpoint for your agents: ${published.url}/mcp (Authorization: Bearer <the same token>)`);
    return;
  }
  if (command === "stop") {
    const result = await stopDaemon({ root });
    log(result.stopped ? "tailscaled stopped." : "tailscaled was not running.");
    return;
  }
  if (command === "status") {
    const status = await tailnetStatus({ root });
    log(`Tailscale: ${status.installed ? `installed ${status.installed}` : "not installed"}`);
    log(`Daemon: ${status.daemonPid ? `running (pid ${status.daemonPid})` : "stopped"}; backend ${status.backendState}`);
    if (status.node) log(`Node: ${status.node} (${status.ips.join(", ") || "no IPs"})`);
    if (status.serve) log(`Serve:\n${status.serve.split("\n").map((line) => `  ${line}`).join("\n")}`);
    if (status.node && status.serve) {
      const token = await ensureToken(config.chatTokenPath || join(root, "chat-token"));
      const https = /https:\/\//.test(status.serve);
      log(`Chat: ${https ? "https" : "http"}://${status.node}/?token=${token}`);
      log(`MCP:  ${https ? "https" : "http"}://${status.node}/mcp`);
    }
    return;
  }
  throw new Error(`Unknown command ${command}\n\n${usage()}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${redactDiagnostic(error?.message || error, 600)}\n`);
    process.exitCode = 1;
  });
}
