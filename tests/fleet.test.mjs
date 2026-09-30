import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BotClient, DEFAULT_TAG, discover, fleetNodes, fleetToolCall } from "../scripts/fleet.mjs";

const script = fileURLToPath(new URL("../scripts/fleet.mjs", import.meta.url));

const status = {
  Self: { HostName: "vps", DNSName: "vps.tail1234.ts.net.", Tags: [], Online: true },
  Peer: {
    a: { HostName: "ship-desk", DNSName: "ship-desk.tail1234.ts.net.", Tags: [DEFAULT_TAG], Online: true, TailscaleIPs: ["100.64.0.9"] },
    b: { HostName: "grokrouter-52281608", DNSName: "grokrouter-52281608.tail1234.ts.net.", Tags: [], Online: false },
    c: { HostName: "laptop", DNSName: "laptop.tail1234.ts.net.", Tags: ["tag:person"], Online: true },
  },
};

test("fleet nodes are the tagged or grokrouter- prefixed peers, addressable by short name", () => {
  const nodes = fleetNodes(status);
  assert.deepEqual(nodes.map((node) => [node.name, node.dns, node.online]), [
    ["52281608", "grokrouter-52281608.tail1234.ts.net", false],
    ["ship-desk", "ship-desk.tail1234.ts.net", true],
  ]);
  assert.deepEqual(fleetNodes(status, { only: ["ship-desk"] }).map((node) => node.name), ["ship-desk"]);
  assert.deepEqual(fleetNodes(status, { only: ["grokrouter-52281608"] }).map((node) => node.name), ["52281608"]);
  assert.deepEqual(fleetNodes({}), []);
});

test("a Bot client finds the reachable base, rejects a bad token, and unwraps MCP tool results", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.startsWith("https://")) throw new Error("connect ECONNREFUSED");
    if (url.endsWith("/api/health")) return new Response(JSON.stringify({ ok: true, version: "0.1.0-test" }), { status: 200 });
    const body = JSON.parse(init.body);
    if (body.params.name === "status") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Anthropic is active" }], structuredContent: { provider: "anthropic", version: "0.1.0-test" } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "boom" }], isError: true } }), { status: 200 });
  };
  const client = new BotClient({ name: "ship-desk", dns: "ship-desk.tail1234.ts.net" }, { token: "t", fetchImpl });
  const result = await client.tool("status", { bot: "fleet" });
  assert.equal(result.text, "Anthropic is active");
  assert.equal(result.structured.provider, "anthropic");
  assert.equal(client.base, "http://ship-desk.tail1234.ts.net");
  assert.deepEqual(calls.slice(0, 2), ["https://ship-desk.tail1234.ts.net/api/health", "http://ship-desk.tail1234.ts.net/api/health"]);
  await assert.rejects(client.tool("delegate", { task: "x" }), /ship-desk: boom/);
  const rejected = new BotClient({ name: "other", dns: "other.tail1234.ts.net" }, { token: "t", fetchImpl: async () => new Response("{}", { status: 401 }) });
  await assert.rejects(rejected.resolveBase(), /token was rejected/);
});

test("fleet tools fan out over the discovered Bots and address one by name", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/api/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    const body = JSON.parse(init.body);
    seen.push([url, body.params.name, body.params.arguments]);
    const text = body.params.name === "upgrade" ? "Upgrade started" : `${url.includes("ship-desk") ? "ship" : "other"} ${body.params.name}`;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }], structuredContent: { version: "0.1.0-test", provider: "anthropic", model: "claude-opus-5-5", reasoning: "xhigh", providers: ["anthropic"] } } }), { status: 200 });
  };
  const options = { token: "t", fetchImpl, status, caller: "hermes" };
  const bots = await fleetToolCall("bots", {}, options);
  assert.equal(bots.structuredContent.bots.length, 2);
  assert.match(bots.content[0].text, /ship-desk: GrokRouter 0.1.0-test · anthropic · claude-opus-5-5 · xhigh/);
  const delegate = await fleetToolCall("delegate", { bot: "ship-desk", task: "list files" }, options);
  assert.equal(delegate.content[0].text, "ship delegate");
  assert.deepEqual(seen.at(-1)[2], { task: "list files", bot: "hermes" });
  await assert.rejects(fleetToolCall("delegate", { bot: "nope", task: "x" }, options), /Unknown bot nope; known: 52281608, ship-desk/);
  const upgrade = await fleetToolCall("upgrade", {}, options);
  assert.match(upgrade.content[0].text, /52281608: Upgrade started\nship-desk: Upgrade started/);
  assert.equal(await fleetToolCall("nope", {}, options), null);
});

test("discovery probes untagged online nodes and identifies a Bot by its GrokRouter service marker", async () => {
  const probeStatus = {
    Self: { HostName: "vps", DNSName: "vps.tail1234.ts.net.", Tags: [], Online: true },
    Peer: {
      a: { HostName: "ship-desk", DNSName: "ship-desk.tail1234.ts.net.", Tags: [], Online: true, TailscaleIPs: ["100.0.0.9"] },
      b: { HostName: "laptop", DNSName: "laptop.tail1234.ts.net.", Tags: [], Online: true },
      c: { HostName: "grok-bot-box", DNSName: "grok-bot-box.tail1234.ts.net.", Tags: [], Online: false },
    },
  };
  const probed = [];
  const fetchImpl = async (url) => {
    probed.push(url);
    if (!url.endsWith("/api/health")) throw new Error(`unexpected ${url}`);
    if (url.includes("ship-desk")) return new Response(JSON.stringify({ service: "grokrouter", version: "0.1.0", mode: "delegation" }), { status: 200 });
    return new Response(JSON.stringify({ hello: "world" }), { status: 200 });
  };
  const found = await discover({ token: "t", fetchImpl, status: probeStatus, probe: true });
  assert.deepEqual(found.map((entry) => entry.node.name), ["ship-desk"]);
  assert.equal(found[0].client.base, "https://ship-desk.tail1234.ts.net");
  assert.ok(!probed.some((url) => url.includes("grok-bot-box")), "offline nodes are not probed");
  const none = await discover({ token: "t", fetchImpl, status: probeStatus, probe: false });
  assert.deepEqual(none.map((entry) => entry.node.name), []);
});

test("the fleet CLI refuses to run without a token and prints usage", () => {
  const help = execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.match(help, /GrokRouter fleet/);
  const withoutToken = spawnSync(process.execPath, [script, "bots"], { encoding: "utf8", env: { ...process.env, GROKROUTER_CHAT_TOKEN: "" } });
  assert.notEqual(withoutToken.status, 0);
  assert.match(withoutToken.stderr, /A chat token is required/);
});
