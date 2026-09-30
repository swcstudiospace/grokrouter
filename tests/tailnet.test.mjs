import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TAILSCALE_DOWNLOAD_BASE,
  defaultHostname,
  loginUrlFrom,
  nodeName,
  resolveRelease,
  serveUrlFor,
  tailnetPaths,
  tailnetStatus,
  tailscaleArch,
} from "../runtime/tailnet.mjs";

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

test("the static Tailscale build is resolved from the package index for this architecture", async () => {
  const index = { Version: "1.102.4", TarballsVersion: "1.102.4", Tarballs: { amd64: "tailscale_1.102.4_amd64.tgz", arm64: "tailscale_1.102.4_arm64.tgz" } };
  const release = await resolveRelease({ fetchImpl: async () => jsonResponse(index), arch: "amd64" });
  assert.deepEqual(release, {
    version: "1.102.4",
    tarball: "tailscale_1.102.4_amd64.tgz",
    url: `${TAILSCALE_DOWNLOAD_BASE}tailscale_1.102.4_amd64.tgz`,
    directory: "tailscale_1.102.4_amd64",
  });
  await assert.rejects(resolveRelease({ fetchImpl: async () => jsonResponse(index), arch: "riscv64" }), /did not name a usable tarball/);
  await assert.rejects(resolveRelease({ fetchImpl: async () => jsonResponse({ Tarballs: { amd64: "../evil.tgz" }, Version: "1.0.0" }), arch: "amd64" }), /usable tarball/);
  await assert.rejects(resolveRelease({ fetchImpl: async () => jsonResponse({}, 503), arch: "amd64" }), /answered 503/);
  assert.equal(tailscaleArch("x64"), "amd64");
  assert.equal(tailscaleArch("arm64"), "arm64");
  assert.equal(tailscaleArch("mips"), null);
});

test("login links, node names, hostnames and serve URLs are derived without shelling out", () => {
  assert.equal(loginUrlFrom("To authenticate, visit:\n\n\thttps://login.tailscale.com/a/1e02e2f40175ec\n"), "https://login.tailscale.com/a/1e02e2f40175ec");
  assert.equal(loginUrlFrom("Success."), null);
  const status = { BackendState: "Running", Self: { DNSName: "grokrouter-52281608.tail1234.ts.net." }, TailscaleIPs: ["100.64.0.9"] };
  assert.equal(nodeName(status), "grokrouter-52281608.tail1234.ts.net");
  assert.equal(nodeName({}), null);
  assert.equal(serveUrlFor(status, { https: true, token: "tok" }), "https://grokrouter-52281608.tail1234.ts.net/?token=tok");
  assert.equal(serveUrlFor(status, { https: false }), "http://grokrouter-52281608.tail1234.ts.net");
  assert.equal(serveUrlFor(status, { https: true, port: 8443 }), "https://grokrouter-52281608.tail1234.ts.net:8443");
  assert.equal(serveUrlFor({}, { https: true }), null);
  assert.equal(defaultHostname("grok-bot-vm-52281608"), "grokrouter-52281608");
  assert.equal(defaultHostname("Ship Desk!!"), "grokrouter-desk");
  assert.equal(defaultHostname("---"), "grokrouter-bot");
});

test("status reports a Bot computer that has never installed Tailscale as stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokrouter-tailnet-"));
  try {
    const paths = tailnetPaths(root);
    assert.equal(paths.socket, join(root, "tailscale", "tailscaled.sock"));
    const status = await tailnetStatus({ root });
    assert.deepEqual(status, { installed: null, daemonPid: null, backendState: "Stopped", node: null, ips: [], serve: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
