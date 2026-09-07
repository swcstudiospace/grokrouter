import hashlib
import importlib.util
import json
from pathlib import Path
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
function runInference(host) {
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

    def enable_anchor_verification(self, min_bytes=0, max_bytes=0):
        self.manifest["anchorVerifiedHosts"] = router_patch.validate_anchor_policy(
            {"enabled": True, "minBytes": min_bytes, "maxBytes": max_bytes}
        )

    def test_shipped_manifest_enables_anchor_verified_hosts_within_a_size_band(self):
        manifest = router_patch.load_manifest(PROJECT_ROOT / "patch" / "manifests" / "0.30.0.json")
        policy = manifest["anchorVerifiedHosts"]
        self.assertTrue(policy["enabled"])
        self.assertLessEqual(policy["minBytes"], 25656693)
        self.assertGreaterEqual(policy["maxBytes"], 26377223)

    def test_anchor_verified_variant_installs_backs_up_and_restores(self):
        self.enable_anchor_verification()
        variant = STOCK_SOURCE + "// rotated stock variant\n"
        self.host.write_text(variant)
        report = router_patch.inspect_host(self.host, self.manifest)
        self.assertEqual(report["status"], "anchor-verified-stock")
        self.assertEqual(report["hostTrust"], router_patch.TRUST_ANCHOR)
        self.assertTrue(report["ok"])
        self.assertIn("HOSTTRUST=ANCHOR-VERIFIED", router_patch.compatibility_report(self.host, self.manifest))

        result = router_patch.install(
            self.host, self.backup, self.manifest, dry_run=False, allow_unknown=False
        )
        self.assertEqual(result["status"], "installed")
        self.assertEqual(result["stockTrust"], router_patch.TRUST_ANCHOR)
        self.assertIn(router_patch.MARKER, self.host.read_text())
        self.assertEqual(self.backup.read_text(), variant)

        health = router_patch.doctor(self.host, self.backup, self.manifest)
        self.assertTrue(health["ok"])
        self.assertTrue(health["stockBackupVerified"])
        self.assertEqual(health["stockBackupTrust"], router_patch.TRUST_ANCHOR)

        restored = router_patch.restore(
            self.host, self.backup, self.manifest, dry_run=False, allow_unknown=False
        )
        self.assertEqual(restored["status"], "restored")
        self.assertEqual(self.host.read_text(), variant)

    def test_anchor_verification_verdict_is_cached_beside_the_file(self):
        self.enable_anchor_verification()
        self.host.write_text(STOCK_SOURCE + "// cached variant\n")
        first = router_patch.anchor_verification(self.host, self.manifest)
        self.assertTrue(first["ok"])
        cache = self.host.with_name(self.host.name + router_patch.TRUST_CACHE_SUFFIX)
        self.assertTrue(cache.exists())
        cached = json.loads(cache.read_text())
        self.assertEqual(cached["result"], first)
        # A changed file invalidates the cached verdict.
        self.host.write_text(STOCK_SOURCE.replace("function createMockPromptExecutor", "function wrong"))
        self.assertFalse(router_patch.anchor_verification(self.host, self.manifest)["ok"])

    def test_backup_follows_the_live_stock_variant(self):
        self.enable_anchor_verification()
        self.backup.write_text(STOCK_SOURCE + "// older variant\n")
        variant = STOCK_SOURCE + "// newer variant\n"
        self.host.write_text(variant)
        router_patch.install(self.host, self.backup, self.manifest, dry_run=False, allow_unknown=False)
        self.assertEqual(self.backup.read_text(), variant)

    def test_anchor_verification_rejects_foreign_router_and_size_band(self):
        self.enable_anchor_verification()
        self.host.write_text(STOCK_SOURCE + "// OpenGrok adapter installed here\n")
        verdict = router_patch.anchor_verification(self.host, self.manifest)
        self.assertFalse(verdict["ok"])
        self.assertIn("another router", verdict["reason"])
        with self.assertRaisesRegex(router_patch.PatchError, "another router"):
            router_patch.install(self.host, self.backup, self.manifest, dry_run=True, allow_unknown=False)

        self.host.write_text(STOCK_SOURCE + "// tiny\n")
        self.enable_anchor_verification(min_bytes=10_000_000, max_bytes=20_000_000)
        verdict = router_patch.anchor_verification(self.host, self.manifest)
        self.assertFalse(verdict["ok"])
        self.assertIn("smaller than expected", verdict["reason"])
        self.assertEqual(verdict["patchDryRun"], "pass")
        with self.assertRaisesRegex(router_patch.PatchError, "HOSTTRUST=NONE"):
            router_patch.install(self.host, self.backup, self.manifest, dry_run=True, allow_unknown=False)

    def test_anchor_verification_is_off_unless_the_manifest_enables_it(self):
        self.host.write_text(STOCK_SOURCE + "// changed\n")
        verdict = router_patch.anchor_verification(self.host, self.manifest)
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["patchDryRun"], "pass")
        self.assertIn("disabled", verdict["reason"])
        self.assertIsNone(router_patch.host_trust(self.host, self.manifest))

    def test_missing_or_duplicate_anchor_is_rejected(self):
        self.host.write_text(STOCK_SOURCE.replace("function createMockPromptExecutor", "function wrong"))
        self.assertEqual(router_patch.inspect_host(self.host, self.manifest)["patchDryRun"], "fail")
        digest = hashlib.sha256(self.host.read_bytes()).hexdigest()
        self.manifest["stockHosts"] = [{"sha256": digest, "bytes": self.host.stat().st_size}]
        with self.assertRaises(router_patch.PatchError):
            router_patch.install(
                self.host, self.backup, self.manifest, dry_run=True, allow_unknown=False
            )


if __name__ == "__main__":
    unittest.main()


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

    def test_shipped_manifests_cover_both_supported_versions(self):
        shipped = PROJECT_ROOT / "patch" / "manifests"
        versions = sorted(router_patch.load_manifest(path)["grokBotVersion"] for path in shipped.glob("*.json"))
        self.assertEqual(versions, ["0.30.0", "0.44.0"])
        new = router_patch.load_manifest(shipped / "0.44.0.json")
        self.assertIn("const mockResponse = options2.agentMockResponse;", new["requiredAnchors"])
        self.assertEqual(new["stockHosts"][0]["bytes"], 28264284)

    def test_registry_for_another_version_is_ignored_when_optional(self):
        manifest = router_patch.resolve_manifest(self.manifests, self.new_host)
        registry_path = Path(self.temporary.name) / "registry.json"
        registry_path.write_text(json.dumps({"schemaVersion": 1, "grokBotVersion": "0.30.0", "stockHosts": []}))
        self.assertIsNone(router_patch.load_host_registry(registry_path, manifest, optional_version=True))
        with self.assertRaises(router_patch.PatchError):
            router_patch.load_host_registry(registry_path, manifest)
