import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "router_patch", PROJECT_ROOT / "patch" / "router_patch.py"
)
router_patch = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(router_patch)


STOCK_SOURCE = """\
class MockPromptExecutor {
  constructor(factory, messages) {}
}
function createMockPromptExecutor(options2) {
  return new MockPromptExecutor(() => options2(), void 0);
}
class Host {
  createSession(onRequestId, sessionOptions) {
      const mockResponse = process.env.SAND_AGENT_MOCK_RESPONSE;
      return mockResponse;
  }
}
function runInference(host, options2 = {}) {
  const boxId = host.resolveBoxId();
  const rawTranscriptText = "@Research Bot /provider";
  const mainSessionOptions = {
          modelId: host.subagentModelId,
          isSubagent: host.isSubagentRunner,
  };
  return mainSessionOptions;
}
function buildResult(host, finalAssistantText, sentMessageCount) {
  return {
    ...!host.isSubagentRunner ? { finalAssistantText } : {},
  };
}
async function runGroup(runner, roomSession, request3, promptForAttempt) {
  const memberResult = await runner.run(promptForAttempt, {
    isGroupMemberTurn: true,
  });
  return memberResult;
}
async function runEpisodeSummary(session) {
  const narrative = await summarizeEpisode({
    executor: session.getExecutor(),
  });
  return narrative;
}
async function runMemoryExtraction(session) {
  const extraction = await extractMemories({
    executor: session.getExecutor(),
  });
  return extraction;
}

"""


class RouterPatchTests(unittest.TestCase):
    def test_released_stock_hashes_keep_their_verified_byte_counts(self):
        manifest = router_patch.load_manifest(PROJECT_ROOT / "patch" / "manifests" / "0.30.0.json")
        pairs = {item["sha256"]: item["bytes"] for item in manifest["stockHosts"]}
        self.assertEqual(
            pairs["3364e421402302f8264f961637addb3997a817fde84a91b19635a0c28ff3941f"],
            25656693,
        )

    def test_default_stock_backup_survives_host_directory_replacement(self):
        self.assertEqual(
            router_patch.DEFAULT_BACKUP,
            Path("/home/box/sand-data/grokbot-router-backup/host-main.cjs.stock"),
        )
        self.assertIn(
            Path("/home/box/sand-host/host-main.cjs.grokbot-router.stock"),
            router_patch.LEGACY_BACKUPS,
        )

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.host = root / "host-main.cjs"
        self.backup = root / "host-main.cjs.grokbot-router.stock"
        self.manifest_path = root / "manifest.json"
        self.host.write_text(STOCK_SOURCE)
        digest = hashlib.sha256(self.host.read_bytes()).hexdigest()
        self.manifest_path.write_text(
            json.dumps(
                {
                    "grokBotVersion": "test",
                    "stockHosts": [{"sha256": digest, "bytes": self.host.stat().st_size}],
                    "requiredAnchors": [
                        "function createMockPromptExecutor(options2)",
                        "createSession(onRequestId, sessionOptions)",
                        "const mockResponse = process.env.SAND_AGENT_MOCK_RESPONSE;",
                    ],
                }
            )
        )
        self.manifest = router_patch.load_manifest(self.manifest_path)

    def tearDown(self):
        self.temporary.cleanup()

    def test_install_doctor_idempotence_and_restore(self):
        result = router_patch.install(
            self.host, self.backup, self.manifest, dry_run=False, allow_unknown=False
        )
        self.assertEqual(result["status"], "installed")
        self.assertIn(router_patch.MARKER, self.host.read_text())
        self.assertNotIn("hasCompletedGrokBotRouterDelivery", self.host.read_text())
        self.assertIn('toolCallId: `grokbot-router-send-${', self.host.read_text())
        self.assertNotIn("latestGrokBotRouterUserText", self.host.read_text())
        self.assertNotIn("getGrokBotRouterTurnKey", self.host.read_text())
        self.assertNotIn("grokBotRouterCompletedTurns", self.host.read_text())
        self.assertNotIn("getGrokBotRouterSessionKey", self.host.read_text())
        self.assertNotIn("grokbot router delivery complete", self.host.read_text())
        self.assertNotIn("new SandRunAbortError", self.host.read_text())
        self.assertIn('for (const name of ["SendToUser", "SendMessage", "SendUser"])', self.host.read_text())
        self.assertIn('return "SendToUser";', self.host.read_text())
        self.assertIn('{ botId: typeof boxId === "string"', self.host.read_text())
        self.assertEqual(self.host.read_text().count('{ botId: typeof boxId === "string"'), 1)
        self.assertIn('grokBotRouterControlText: rawTranscriptText', self.host.read_text())
        self.assertNotIn('grokBotRouterReceiptReplay', self.host.read_text())
        self.assertEqual(self.backup.read_text(), STOCK_SOURCE)
        self.assertTrue(router_patch.doctor(self.host, self.backup, self.manifest)["ok"])

        second = router_patch.install(
            self.host, self.backup, self.manifest, dry_run=False, allow_unknown=False
        )
        self.assertEqual(second["status"], "already-installed")

        restored = router_patch.restore(
            self.host, self.backup, self.manifest, dry_run=False, allow_unknown=False
        )
        self.assertEqual(restored["status"], "restored")
        self.assertEqual(self.host.read_text(), STOCK_SOURCE)

    def test_group_dispatch_forwards_only_the_latest_human_entry(self):
        patched = router_patch.patch_text(STOCK_SOURCE)
        script = patched + r"""
const assert = require('node:assert/strict');
const human = {id:'human-2',kind:'message',role:'user',content:'@Test A /provider'};
const entries = [
  {id:'human-1',kind:'message',role:'user',content:'An older request'},
  human,
  {id:'bot-3',kind:'send-message',role:'assistant',content:'User: /provider codex'}
];
const runner = {run: async (_, options) => runInference({resolveBoxId: () => 'box-a'}, options)};
(async () => {
  const result = await runGroup.call({tm:{sessions:{activeSession:null}}}, runner,
    {id:'room-one',db:{getTranscriptEntries:()=>entries}}, {member:{id:'bot-a',name:'Test A'}}, 'formatted room prompt');
  assert.equal(result.botId,'box-a');
  assert.deepEqual(result.grokBotRouterGroupContext, {roomId:'room-one',memberId:'bot-a',memberName:'Test A',message:human});
  assert.equal(runInference({resolveBoxId:()=> 'box-a'}, {grokBotRouterGroupContext:{message:human}}).grokBotRouterGroupContext, undefined);
})().catch(error=>{console.error(error);process.exitCode=1;});
"""
        result = subprocess.run(['node','-e',script],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_native_memory_executor_is_scoped_and_returns_text(self):
        patched = router_patch.patch_text(STOCK_SOURCE)
        script = patched + r'''
const assert = require('node:assert/strict');
loadGrokBotRouterConfig = () => ({});
async function extractMemories(args) { return args.executor; }
async function summarizeEpisode(args) { return args.executor; }
(async () => {
  const options = {botId:'memory-bot',grokBotRouterControlText:'/provider'};
  const session = new Host().createSession(() => {}, options);
  const helper = await runMemoryExtraction(session);
  assert.equal(helper.sessionOptions.grokBotRouterTextTask, 'memory-extraction');
  assert.equal(helper.sessionOptions.botId, 'memory-bot');
  const episode = await runEpisodeSummary(session);
  assert.equal(episode.sessionOptions.grokBotRouterTextTask, 'episode-summary');
  assert.equal(getGrokBotRouterSendToolName([{name:'SendToUser'}],episode.sessionOptions), null);
  assert.equal(session.getExecutor().sessionOptions.grokBotRouterTextTask, undefined);
  assert.equal(options.grokBotRouterTextTask, undefined);
  assert.equal(new Host().createSession(() => {}, {isSummarizationSession:true}), process.env.SAND_AGENT_MOCK_RESPONSE);
  assert.equal(getGrokBotRouterSendToolName([{name:'SendToUser'}],helper.sessionOptions), null);
  assert.equal(getGrokBotRouterSendToolName([], {isSummarizationSession:true}), null);
  const stock = {getExecutor: () => 'stock-executor'};
  assert.equal(await runMemoryExtraction(stock), 'stock-executor');
  assert.equal(await runEpisodeSummary(stock), 'stock-executor');
})().catch(error=>{console.error(error);process.exitCode=1;});
'''
        result = subprocess.run(['node','-e',script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with self.assertRaisesRegex(router_patch.PatchError, 'Memory extraction executor anchor'):
            router_patch.patch_text(STOCK_SOURCE.replace('const extraction = await extractMemories', 'const changed = await extractMemories'))
        with self.assertRaisesRegex(router_patch.PatchError, 'Episode summary executor anchor'):
            router_patch.patch_text(STOCK_SOURCE.replace('const narrative = await summarizeEpisode', 'const changed = await summarizeEpisode'))

    def test_executor_finishes_children_without_inventing_a_delivery_tool(self):
        # Exercise the injected executor protocol against a minimal host double.
        # Child sessions offer execution tools, but no user-delivery tool.
        script = r'''const assert = require("node:assert/strict");
class MockPromptExecutor {
  constructor(factory, messages = []) {
    this.factory = factory;
    this.builder = { getMessages: () => messages };
  }
  stream() {
    const value = this.factory();
    return { response: Promise.resolve(value), fullStream: (async function* () {})() };
  }
}
''' + router_patch.EXECUTOR_CODE + r'''
(async () => {
  let nextResult = { text: "56", toolCalls: [], usage: {} };
  runGrokBotRouter = async () => nextResult;
  const execute = async (tools, isSubagent = true) => {
    const executor = new GrokBotRouterPromptExecutor({}, {isSubagent}, []);
    return await executor.stream({}, "probe", tools, {}).response;
  };
  const child = await execute([{name:"Shell"}, {name:"Read"}]);
  assert.equal(child.response, "56");
  assert.deepEqual(child.toolCalls, []);
  const emptySchema = await execute([]);
  assert.equal(emptySchema.response, "56");
  assert.deepEqual(emptySchema.toolCalls, []);
  const parent = await execute([{name:"SendMessage"}, {name:"SendToUser"}], false);
  assert.equal(parent.response, "");
  assert.equal(parent.toolCalls.length, 1);
  assert.equal(parent.toolCalls[0].toolName, "SendToUser");
  assert.match(parent.toolCalls[0].toolCallId, /^grokbot-router-send-/);
  assert.equal(parent.toolCalls[0].args.content, "56");
  const parentInternal = await execute([{name:"Shell"}], false);
  assert.equal(parentInternal.response, "");
  assert.equal(parentInternal.toolCalls[0].toolName, "SendToUser");
  const childWithDelivery = await execute([{name:"SendToUser"}]);
  assert.equal(childWithDelivery.response, "56");
  assert.deepEqual(childWithDelivery.toolCalls, []);
  const helper = new GrokBotRouterPromptExecutor({}, {grokBotRouterTextTask:"memory-extraction"}, []);
  const memory = await helper.stream({}, "memory", [], {}).response;
  assert.equal(memory.response, "56");
  assert.deepEqual(memory.toolCalls, []);
  nextResult = {text:"Working",toolCalls:[{toolName:"Shell",toolCallId:"actual-call",args:{command:"true"}}]};
  const toolTurn = await execute([{name:"Shell"}]);
  assert.equal(toolTurn.response, "");
  assert.deepEqual(toolTurn.toolCalls, nextResult.toolCalls);
  nextResult = {text:"",toolCalls:[],alreadyDelivered:true};
  const cleanup = await execute([{name:"SendToUser"}]);
  assert.equal(cleanup.response, "");
  assert.deepEqual(cleanup.toolCalls, []);
})().catch(error => { console.error(error); process.exitCode = 1; });
'''
        result = subprocess.run(["node", "-"], input=script, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unknown_host_is_rejected_without_development_override(self):
        self.host.write_text(STOCK_SOURCE + "// changed\n")
        report = router_patch.inspect_host(self.host, self.manifest)
        self.assertEqual(report["patchDryRun"], "pass")
        self.assertTrue(all(len(line) < 80 for line in router_patch.compatibility_report(self.host, self.manifest).splitlines()))
        with self.assertRaisesRegex(router_patch.PatchError, "HOSTSHA1="):
            router_patch.install(
                self.host, self.backup, self.manifest, dry_run=True, allow_unknown=False
            )

    def test_exact_hash_with_wrong_size_is_rejected(self):
        digest = hashlib.sha256(self.host.read_bytes()).hexdigest()
        self.manifest["stockHosts"] = [{"sha256": digest, "bytes": self.host.stat().st_size + 1}]
        with self.assertRaises(router_patch.PatchError):
            router_patch.install(
                self.host, self.backup, self.manifest, dry_run=True, allow_unknown=False
            )

    def test_signed_registry_can_extend_exact_hash_and_size_pairs(self):
        self.host.write_text(STOCK_SOURCE + "// compatible variant\n")
        digest = hashlib.sha256(self.host.read_bytes()).hexdigest()
        registry_path = Path(self.temporary.name) / "registry.json"
        registry_path.write_text(json.dumps({
            "schemaVersion": 1,
            "grokBotVersion": "test",
            "stockHosts": [{"sha256": digest, "bytes": self.host.stat().st_size}],
        }))
        registry = router_patch.load_host_registry(registry_path, self.manifest)
        result = router_patch.install(
            self.host,
            self.backup,
            self.manifest,
            dry_run=True,
            allow_unknown=False,
            registry=registry,
        )
        self.assertEqual(result["status"], "dry-run")

    def test_structural_policy_cannot_authorize_a_modified_host(self):
        self.manifest["anchorVerifiedHosts"] = {"enabled": True, "minBytes": 0, "maxBytes": 0}
        self.host.write_text(STOCK_SOURCE + "globalThis.nonStockModification = true;\n")
        report = router_patch.inspect_host(self.host, self.manifest)
        self.assertEqual(report["patchDryRun"], "pass")
        self.assertIsNone(report["hostTrust"])
        self.assertFalse(report["ok"])
        self.assertIsNone(router_patch.host_trust(self.host, self.manifest))
        with self.assertRaises(router_patch.PatchError):
            router_patch.install(self.host, self.backup, self.manifest, False, False)

    def test_backup_does_not_authorize_replacing_rejected_hosts(self):
        variants = [
            STOCK_SOURCE + "// unknown rotated stock\n",
            STOCK_SOURCE + "// OpenGrok adapter installed here\n",
            "throw new Error('incompatible replacement');\n",
            STOCK_SOURCE + f"// {router_patch.MARKER} forged marker\n",
            STOCK_SOURCE + "// GROKBOT_MODEL_ROUTER_V44 forged legacy marker\n",
        ]
        self.backup.write_text(STOCK_SOURCE)
        for variant in variants:
            with self.subTest(variant=variant[-80:]):
                self.host.write_text(variant)
                for dry_run in (True, False):
                    with self.assertRaisesRegex(router_patch.PatchError, "live host was not replaced"):
                        router_patch.install(self.host, self.backup, self.manifest, dry_run, False)
                    self.assertEqual(self.host.read_text(), variant)
                    self.assertEqual(self.backup.read_text(), STOCK_SOURCE)

    def test_doctor_and_repair_reject_a_tampered_router(self):
        router_patch.install(self.host, self.backup, self.manifest, False, False)
        tampered = self.host.read_text() + "globalThis.unreviewed = true;\n"
        self.host.write_text(tampered)
        health = router_patch.doctor(self.host, self.backup, self.manifest)
        self.assertFalse(health["ok"])
        self.assertFalse(health["hostAdapterVerified"])
        self.assertTrue(health["stockBackupVerified"])
        with self.assertRaises(router_patch.PatchError):
            router_patch.install(self.host, self.backup, self.manifest, False, False)
        self.assertEqual(self.host.read_text(), tampered)
        # An explicit restoration is distinct from automatic repair.
        router_patch.restore(self.host, self.backup, self.manifest, False, False)
        self.assertEqual(self.host.read_text(), STOCK_SOURCE)

    def test_every_published_adapter_upgrades_in_place_and_only_byte_exactly(self):
        fixture = (PROJECT_ROOT / "tests" / "fixtures" / "host-main.cjs").read_text()
        self.backup.write_text(fixture)
        self.manifest["stockHosts"] = [{"sha256": router_patch.sha256(self.backup), "bytes": self.backup.stat().st_size}]
        current = router_patch.patch_text(fixture)
        published = list(router_patch.previous_adapter_outputs(fixture))
        # Every retained transformation (and version variant) must patch the
        # fixture, or its upgrade path would go untested.
        expected = len(list(router_patch.PREVIOUS_ADAPTERS.glob("*.py"))) + sum(
            len(variants) for variants in router_patch.PREVIOUS_VERSION_VARIANTS.values())
        self.assertEqual(len(set(published)), expected)
        for output in published:
            with self.subTest(adapter=output[output.find('version: "'):][:30]):
                self.assertNotEqual(output, current)
                self.host.write_text(output)
                self.assertEqual(router_patch.install(self.host, self.backup, self.manifest, False, False)["status"], "installed")
                self.assertEqual(self.host.read_text(), current)
                self.assertTrue(router_patch.doctor(self.host, self.backup, self.manifest)["ok"])
                middle = len(output) // 2
                tampered = output[:middle] + ("#" if output[middle] != "#" else "%") + output[middle + 1:]
                self.host.write_text(tampered)
                with self.assertRaisesRegex(router_patch.PatchError, "live host was not replaced"):
                    router_patch.install(self.host, self.backup, self.manifest, False, False)
                self.assertEqual(self.host.read_text(), tampered)

    def test_exact_reviewed_replacement_updates_backup(self):
        self.backup.write_text(STOCK_SOURCE)
        variant = STOCK_SOURCE + "// independently reviewed new stock\n"
        self.host.write_text(variant)
        self.manifest["stockHosts"].append({"sha256": router_patch.sha256(self.host), "bytes": self.host.stat().st_size})
        router_patch.install(self.host, self.backup, self.manifest, False, False)
        self.assertEqual(self.backup.read_text(), variant)
        router_patch.restore(self.host, self.backup, self.manifest, False, False)
        self.assertEqual(self.host.read_text(), variant)

    def test_syntax_diagnostics_do_not_authorize_unknown_backup_restore(self):
        self.backup.write_text(STOCK_SOURCE + "// unknown backup\n")
        with self.assertRaises(router_patch.PatchError):
            router_patch.restore(self.host, self.backup, self.manifest, False, False)
        self.assertEqual(self.host.read_text(), STOCK_SOURCE)

    def test_missing_or_duplicate_anchor_is_rejected(self):
        self.host.write_text(STOCK_SOURCE.replace("function createMockPromptExecutor", "function wrong"))
        self.assertEqual(router_patch.inspect_host(self.host, self.manifest)["patchDryRun"], "fail")
        digest = hashlib.sha256(self.host.read_bytes()).hexdigest()
        self.manifest["stockHosts"] = [{"sha256": digest, "bytes": self.host.stat().st_size}]
        with self.assertRaises(router_patch.PatchError):
            router_patch.install(
                self.host, self.backup, self.manifest, dry_run=True, allow_unknown=False
            )


class MultiVersionManifestTests(unittest.TestCase):
    """Grok Bot 0.44.0 reads the mock response from the executor options."""

    NEW_SOURCE = STOCK_SOURCE.replace(
        "const mockResponse = process.env.SAND_AGENT_MOCK_RESPONSE;",
        "const mockResponse = options2.agentMockResponse;",
    )

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.manifests = root / "manifests"
        self.manifests.mkdir()
        self.old_host = root / "old-host.cjs"
        self.old_host.write_text(STOCK_SOURCE)
        self.new_host = root / "new-host.cjs"
        self.new_host.write_text(self.NEW_SOURCE)
        self.backup = root / "backup.stock"
        for version, host, mock_anchor in (
            ("0.30.0", self.old_host, "const mockResponse = process.env.SAND_AGENT_MOCK_RESPONSE;"),
            ("0.44.0", self.new_host, "const mockResponse = options2.agentMockResponse;"),
        ):
            digest = hashlib.sha256(host.read_bytes()).hexdigest()
            (self.manifests / f"{version}.json").write_text(json.dumps({
                "grokBotVersion": version,
                "stockHosts": [{"sha256": digest, "bytes": host.stat().st_size}],
                "requiredAnchors": [
                    "function createMockPromptExecutor(options2)",
                    "createSession(onRequestId, sessionOptions)",
                    mock_anchor,
                    "const mainSessionOptions = {",
                ],
            }))

    def tearDown(self):
        self.temporary.cleanup()

    def test_directory_selects_the_manifest_matching_each_host(self):
        self.assertEqual(router_patch.resolve_manifest(self.manifests, self.old_host)["grokBotVersion"], "0.30.0")
        self.assertEqual(router_patch.resolve_manifest(self.manifests, self.new_host)["grokBotVersion"], "0.44.0")
        single = router_patch.resolve_manifest(self.manifests / "0.30.0.json", self.new_host)
        self.assertEqual(single["grokBotVersion"], "0.30.0")

    def test_new_mock_anchor_installs_doctors_and_restores(self):
        manifest = router_patch.resolve_manifest(self.manifests, self.new_host)
        router_patch.install(self.new_host, self.backup, manifest, dry_run=False, allow_unknown=False)
        patched = self.new_host.read_text()
        self.assertIn("GROKBOT_MODEL_ROUTER_V45", patched)
        self.assertIn("const mockResponse = options2.agentMockResponse;", patched)
        self.assertEqual(patched.count("createSession(onRequestId, sessionOptions)"), 1)
        # A patched host still resolves to its own manifest, so doctor, the
        # watchdog, and restore keep using the same gates after install.
        self.assertEqual(router_patch.resolve_manifest(self.manifests, self.new_host, self.backup)["grokBotVersion"], "0.44.0")
        self.assertTrue(router_patch.doctor(self.new_host, self.backup, manifest)["ok"])
        router_patch.restore(self.new_host, self.backup, manifest, dry_run=False, allow_unknown=False)
        self.assertEqual(self.new_host.read_text(), self.NEW_SOURCE)

    def test_shipped_manifests_are_exactly_the_supported_versions(self):
        shipped = PROJECT_ROOT / "patch" / "manifests"
        supported = json.loads((PROJECT_ROOT / "compatibility" / "supported-apps.json").read_text())["versions"]
        manifests = {path.stem: router_patch.load_manifest(path) for path in shipped.glob("*.json")}
        self.assertEqual(sorted(manifests), sorted(supported))
        for version, manifest in manifests.items():
            self.assertEqual(manifest["grokBotVersion"], version)
            # Reviewed versions trust exact stock hashes only.
            self.assertFalse(manifest["anchorVerifiedHosts"]["enabled"])
        self.assertIn("const mockResponse = options2.agentMockResponse;", manifests["0.44.0"]["requiredAnchors"])

    def test_registry_for_another_version_is_ignored_when_optional(self):
        manifest = router_patch.resolve_manifest(self.manifests, self.new_host)
        registry_path = Path(self.temporary.name) / "registry.json"
        registry_path.write_text(json.dumps({"schemaVersion": 1, "grokBotVersion": "0.30.0", "stockHosts": []}))
        self.assertIsNone(router_patch.load_host_registry(registry_path, manifest, optional_version=True))
        with self.assertRaises(router_patch.PatchError):
            router_patch.load_host_registry(registry_path, manifest)


class PatchSeamTests(unittest.TestCase):
    """The group, memory, and episode seams are mandatory in every version."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.host = root / "host-main.cjs"
        self.backup = root / "backup.stock"
        self.manifest = {
            "grokBotVersion": "test",
            "requiredAnchors": ["function createMockPromptExecutor(options2)"],
            "anchorVerifiedHosts": router_patch.validate_anchor_policy(None),
        }

    def tearDown(self):
        self.temporary.cleanup()

    def test_every_seam_is_reported_and_fails_closed_when_missing(self):
        self.host.write_text(STOCK_SOURCE)
        self.manifest["stockHosts"] = [{"sha256": router_patch.sha256(self.host), "bytes": self.host.stat().st_size}]
        self.assertEqual(router_patch.inspect_host(self.host, self.manifest)["patchAnchorCounts"], [1, 1, 1])
        self.assertIn("PATCHANCHORS=1,1,1", router_patch.compatibility_report(self.host, self.manifest))
        logical_seams = list(router_patch.GROUP_DISPATCH_CANDIDATES) + list(router_patch.PATCH_ANCHORS)
        for index, seam in enumerate(logical_seams):
            with self.subTest(seam=seam):
                source = STOCK_SOURCE.replace(seam, seam.replace("const ", "let ", 1))
                self.host.write_text(source)
                # Even an exact reviewed hash cannot bypass a missing seam.
                self.manifest["stockHosts"] = [{"sha256": router_patch.sha256(self.host), "bytes": self.host.stat().st_size}]
                report = router_patch.inspect_host(self.host, self.manifest)
                self.assertEqual(report["patchAnchorCounts"][index], 0)
                self.assertFalse(report["ok"])
                self.assertEqual(report["patchDryRun"], "fail")
                with self.assertRaisesRegex(router_patch.PatchError, "Host anchor count"):
                    router_patch.install(self.host, self.backup, self.manifest, False, False)
                self.assertEqual(self.host.read_text(), source)


class UnreviewedVersionTests(unittest.TestCase):
    """Structural trust exists only behind an explicit unreviewed-version opt-in."""

    NEW_BUILD = STOCK_SOURCE + "// unreviewed newer Grok Bot build\n"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.host = root / "host-main.cjs"
        self.backup = root / "backup" / "host-main.cjs.stock"
        self.manifest_path = root / "0.44.0.json"
        reviewed = root / "reviewed.cjs"
        reviewed.write_text(STOCK_SOURCE)
        self.manifest_path.write_text(json.dumps({
            "grokBotVersion": "0.44.0",
            "stockHosts": [{"sha256": router_patch.sha256(reviewed), "bytes": reviewed.stat().st_size}],
            "requiredAnchors": [
                "function createMockPromptExecutor(options2)",
                "createSession(onRequestId, sessionOptions)",
                "const mockResponse = process.env.SAND_AGENT_MOCK_RESPONSE;",
                "const mainSessionOptions = {",
            ],
            "anchorVerifiedHosts": {"enabled": False, "minBytes": 100, "maxBytes": 100000},
        }))
        self.manifest = router_patch.load_manifest(self.manifest_path)
        self.host.write_text(self.NEW_BUILD)

    def tearDown(self):
        self.temporary.cleanup()

    def run_cli(self, *extra):
        return subprocess.run(
            [sys.executable, str(PROJECT_ROOT / "patch" / "router_patch.py"), "--host", str(self.host),
             "--backup", str(self.backup), "--manifest", str(self.manifest_path), "--json", *extra],
            capture_output=True, text=True)

    def test_structural_trust_requires_the_explicit_flag(self):
        self.assertIsNone(router_patch.host_trust(self.host, self.manifest))
        with self.assertRaisesRegex(router_patch.PatchError, "HOSTTRUST=NONE"):
            router_patch.install(self.host, self.backup, self.manifest, False, False)
        refused = self.run_cli()
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(self.host.read_text(), self.NEW_BUILD)
        self.assertFalse(self.backup.exists())

    def test_reviewed_older_and_between_versions_never_get_structural_trust(self):
        for version in ("0.44.0", "0.36.0", "0.40.0", "0.29.9", "0.61", "latest", "0.61.0; true"):
            with self.subTest(version=version):
                with self.assertRaises(router_patch.PatchError):
                    router_patch.require_unreviewed_version(version, self.manifest)
                result = self.run_cli("--unreviewed-version", version)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Nothing was changed", result.stderr)
                self.assertEqual(self.host.read_text(), self.NEW_BUILD)
                self.assertFalse(self.backup.exists())

    def test_newer_opt_in_installs_doctors_and_restores_exactly(self):
        installed = self.run_cli("--unreviewed-version", "99.0.0")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        result = json.loads(installed.stdout)
        self.assertEqual(result["status"], "installed")
        self.assertEqual(result["stockTrust"], router_patch.TRUST_UNREVIEWED)
        self.assertEqual(result["unreviewedVersion"], "99.0.0")
        self.assertEqual(result["templateManifestVersion"], "0.44.0")
        self.assertEqual(self.host.read_text(), router_patch.patch_text(self.NEW_BUILD))
        self.assertEqual(self.backup.read_text(), self.NEW_BUILD)

        health = json.loads(self.run_cli("--doctor", "--unreviewed-version", "99.0.0").stdout)
        self.assertTrue(health["ok"])
        self.assertEqual(health["stockBackupTrust"], router_patch.TRUST_UNREVIEWED)
        # Without the opt-in the same backup is not trusted, so repair and
        # restore stay refused rather than silently widening trust.
        self.assertFalse(router_patch.doctor(self.host, self.backup, self.manifest)["ok"])
        with self.assertRaises(router_patch.PatchError):
            router_patch.restore(self.host, self.backup, self.manifest, False, False)
        self.assertEqual(
            json.loads(self.run_cli("--unreviewed-version", "99.0.0").stdout)["status"], "already-installed")

        restored = self.run_cli("--restore", "--unreviewed-version", "99.0.0")
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertEqual(self.host.read_bytes(), self.NEW_BUILD.encode())

    def test_opt_in_still_refuses_hosts_that_fail_structural_checks(self):
        variants = {
            "foreign router": self.NEW_BUILD + "// opengrok adapter\n",
            "legacy marker": self.NEW_BUILD + "// GROKBOT_MODEL_ROUTER_V44\n",
            "duplicate anchor": self.NEW_BUILD + "// const mainSessionOptions = {\n",
            "missing seam": self.NEW_BUILD.replace("const narrative = await", "const story = await"),
            "outside band": self.NEW_BUILD + "//" + "x" * 100000 + "\n",
        }
        for label, source in variants.items():
            with self.subTest(label=label):
                self.host.write_text(source)
                with self.assertRaisesRegex(router_patch.PatchError, "UNREVIEWEDVERSION=99.0.0"):
                    router_patch.install(self.host, self.backup, self.manifest, False, False,
                                         unreviewed_version="99.0.0")
                self.assertEqual(self.host.read_text(), source)
                self.assertFalse(self.backup.exists())
        self.host.write_text(self.NEW_BUILD)
        self.manifest["anchorVerifiedHosts"] = router_patch.validate_anchor_policy(None)
        self.assertIsNone(router_patch.host_trust(self.host, self.manifest, unreviewed_version="99.0.0"))

    def test_template_is_the_newest_manifest_whose_anchors_the_host_proves(self):
        manifests = Path(self.temporary.name) / "manifests"
        manifests.mkdir()
        for version, mock in (("0.30.0", "process.env.SAND_AGENT_MOCK_RESPONSE"),
                              ("0.36.0", "process.env.SAND_AGENT_MOCK_RESPONSE"),
                              ("0.44.0", "options2.agentMockResponse")):
            manifest = json.loads(self.manifest_path.read_text())
            manifest["grokBotVersion"] = version
            manifest["requiredAnchors"][2] = f"const mockResponse = {mock};"
            (manifests / f"{version}.json").write_text(json.dumps(manifest))
        self.assertEqual(router_patch.resolve_template_manifest(manifests, self.host)["grokBotVersion"], "0.36.0")
        self.host.write_text(MultiVersionManifestTests.NEW_SOURCE + "// newer\n")
        self.assertEqual(router_patch.resolve_template_manifest(manifests, self.host)["grokBotVersion"], "0.44.0")
        self.host.write_text(STOCK_SOURCE.replace("createSession(onRequestId", "openSession(onRequestId"))
        with self.assertRaisesRegex(router_patch.PatchError, "host probe"):
            router_patch.resolve_template_manifest(manifests, self.host, self.backup)


if __name__ == "__main__":
    unittest.main()
