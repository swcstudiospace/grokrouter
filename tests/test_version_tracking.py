"""Version-tracking pipeline tests: feed check, probe ingest, auto-probe, gates.

Covers scripts/check-grokbot-version.py, scripts/new-manifest-from-probe.py,
and scripts/auto-probe.py (the unattended runner probe), plus the standing
contract that compatibility/supported-apps.json, the shipped manifests, and
the Swift installer's visible version list agree.
"""
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CHECK_SCRIPT = PROJECT_ROOT / "scripts" / "check-grokbot-version.py"
INGEST_SCRIPT = PROJECT_ROOT / "scripts" / "new-manifest-from-probe.py"
AUTO_PROBE_SCRIPT = PROJECT_ROOT / "scripts" / "auto-probe.py"
_PATCH_TESTS = importlib.util.spec_from_file_location("patch_tests", PROJECT_ROOT / "tests" / "test_patch.py")
patch_tests = importlib.util.module_from_spec(_PATCH_TESTS)
assert _PATCH_TESTS.loader is not None
_PATCH_TESTS.loader.exec_module(patch_tests)

SWIFT_SNIPPET = """\
private let supportedGrokVersions = ["0.30.0", "0.44.0"]
        let eyebrow = NSTextField(labelWithString: "GROK BOT 0.30.0 · 0.44.0")
"""
WINDOWS_SNIPPET = """\
const SUPPORTED_GROK_VERSIONS = ["0.30.0", "0.44.0"];
"""
PATCH_SEAMS = {
    "const memberResult = await runner.run(promptForAttempt, {": 1,
    "const extraction = await extractMemories({": 1,
    "const narrative = await summarizeEpisode({": 1,
}


def make_probe(version="0.58.0", sha="a" * 64, size=28264284,
               counts=None, markers=None, hints=None, seams=None):
    anchors = counts if counts is not None else {
        "function createMockPromptExecutor(options2)": 1,
        "createSession(onRequestId, sessionOptions)": 1,
        "const mockResponse = options2.agentMockResponse;": 1,
        "const mainSessionOptions = {": 1,
    }
    return {
        "ok": True,
        "bytes": size,
        "sha256": sha,
        "versionHints": [version] if hints is None else hints,
        "anchors": {},
        "mockAnchors": {},
        "patchAnchors": dict(PATCH_SEAMS) if seams is None else seams,
        "customAnchors": dict(anchors),
        "candidates": {"routerMarker": [] if markers is None else markers},
    }


def make_skeleton(root: Path) -> None:
    (root / "patch" / "manifests").mkdir(parents=True)
    (root / "patch" / "router_patch.py").write_text(
        (PROJECT_ROOT / "patch" / "router_patch.py").read_text())
    for name in ("0.30.0.json", "0.44.0.json"):
        (root / "patch" / "manifests" / name).write_text(
            (PROJECT_ROOT / "patch" / "manifests" / name).read_text())
    (root / "compatibility").mkdir()
    (root / "compatibility" / "supported-apps.json").write_text(
        json.dumps({"versions": ["0.30.0", "0.44.0"]}))
    (root / "installer").mkdir()
    (root / "installer" / "GrokBotRouterInstaller.swift").write_text(SWIFT_SNIPPET)
    (root / "installer-windows").mkdir()
    (root / "installer-windows" / "main.cjs").write_text(WINDOWS_SNIPPET)


def run_ingest(root: Path, probe: dict, version: str, anchors: list[str]):
    probe_path = root / "probe.json"
    probe_path.write_text(json.dumps(probe))
    command = [sys.executable, str(INGEST_SCRIPT), "--version", version,
               "--probe", str(probe_path), "--root", str(root)]
    for anchor in anchors:
        command += ["--anchor", anchor]
    return subprocess.run(command, capture_output=True, text=True)


ANCHORS_044 = [
    "function createMockPromptExecutor(options2)",
    "createSession(onRequestId, sessionOptions)",
    "const mockResponse = options2.agentMockResponse;",
    "const mainSessionOptions = {",
]


class FeedCheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.manifests = self.root / "manifests"
        self.manifests.mkdir()
        for version in ("0.30.0", "0.44.0"):
            (self.manifests / f"{version}.json").write_text(
                json.dumps({"grokBotVersion": version}))
        self.feed = self.root / "feed.json"
        self.feed.write_text(json.dumps({"version": "0.58.0"}))
        self.supported_apps = self.root / "supported-apps.json"
        self.supported_apps.write_text(json.dumps({
            "versions": ["0.30.0", "0.44.0"],
            "delegation": {"minimumVersion": "0.63.0", "verifiedVersions": ["0.63.0"]},
        }))

    def tearDown(self):
        self.temporary.cleanup()

    def run_check(self, *extra):
        return subprocess.run(
            [sys.executable, str(CHECK_SCRIPT), "--feed-url", self.feed.as_uri(),
             "--manifests", str(self.manifests), "--supported-apps", str(self.supported_apps), *extra],
            capture_output=True, text=True)

    def test_newer_feed_version_reports_unsupported(self):
        result = self.run_check("--check")
        self.assertEqual(result.returncode, 2)
        report = json.loads(result.stdout)
        self.assertEqual(report["feedVersion"], "0.58.0")
        self.assertEqual(report["mode"], "adapter")
        self.assertFalse(report["supportedFeed"])

    def test_verified_delegation_version_passes_without_a_manifest(self):
        self.feed.write_text(json.dumps({"version": "0.63.0"}))
        result = self.run_check("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["mode"], "delegation")
        self.assertTrue(report["supportedFeed"])

    def test_unverified_delegation_version_asks_for_a_live_check_not_a_probe(self):
        self.feed.write_text(json.dumps({"version": "0.64.0"}))
        result = self.run_check("--check")
        self.assertEqual(result.returncode, 3)
        report = json.loads(result.stdout)
        self.assertEqual(report["mode"], "delegation")
        self.assertFalse(report["supportedFeed"])
        self.assertEqual(report["delegation"]["verifiedVersions"], ["0.63.0"])

    def test_without_a_delegation_floor_every_new_version_is_an_adapter_version(self):
        self.supported_apps.write_text(json.dumps({"versions": ["0.30.0", "0.44.0"]}))
        self.feed.write_text(json.dumps({"version": "0.64.0"}))
        result = self.run_check("--check")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["mode"], "adapter")

    def test_supported_feed_version_passes(self):
        self.feed.write_text(json.dumps({"version": "0.44.0"}))
        result = self.run_check("--check")
        self.assertEqual(result.returncode, 0)
        self.assertTrue(json.loads(result.stdout)["supportedFeed"])

    def test_malformed_feed_is_an_error(self):
        self.feed.write_text("{not json")
        self.assertEqual(self.run_check().returncode, 1)


class ProbeIngestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        make_skeleton(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def test_valid_probe_scaffolds_the_exact_per_version_layout(self):
        result = run_ingest(self.root, make_probe(), "0.58.0", ANCHORS_044)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.root / "patch" / "manifests" / "0.58.0.json").read_text())
        self.assertEqual(manifest["grokBotVersion"], "0.58.0")
        self.assertEqual(manifest["stockHosts"], [{"sha256": "a" * 64, "bytes": 28264284}])
        self.assertEqual(manifest["requiredAnchors"], ANCHORS_044)
        self.assertIs(manifest["anchorVerifiedHosts"]["enabled"], False)
        registry = json.loads((self.root / "compatibility" / "0.58.0-hosts.json").read_text())
        self.assertEqual(registry, {"schemaVersion": 1, "grokBotVersion": "0.58.0",
                                    "stockHosts": manifest["stockHosts"]})
        self.assertFalse((self.root / "compatibility" / "0.58.0-hosts.json.sig").exists())
        supported = json.loads((self.root / "compatibility" / "supported-apps.json").read_text())
        self.assertEqual(supported["versions"], ["0.30.0", "0.44.0", "0.58.0"])
        swift = (self.root / "installer" / "GrokBotRouterInstaller.swift").read_text()
        self.assertIn('supportedGrokVersions = ["0.30.0", "0.44.0", "0.58.0"]', swift)
        self.assertIn("GROK BOT 0.30.0 · 0.44.0 · 0.58.0", swift)
        windows = (self.root / "installer-windows" / "main.cjs").read_text()
        self.assertIn('SUPPORTED_GROK_VERSIONS = ["0.30.0", "0.44.0", "0.58.0"]', windows)

    def test_versions_sort_numerically(self):
        result = run_ingest(self.root, make_probe(version="0.100.0"), "0.100.0", ANCHORS_044)
        self.assertEqual(result.returncode, 0, result.stderr)
        supported = json.loads((self.root / "compatibility" / "supported-apps.json").read_text())
        self.assertEqual(supported["versions"], ["0.30.0", "0.44.0", "0.100.0"])

    def test_ingest_refuses_a_probe_that_does_not_prove_every_patch_seam(self):
        for seams in ({**PATCH_SEAMS, "const narrative = await summarizeEpisode({": 0}, None):
            probe = make_probe(seams=seams)
            if seams is None:
                del probe["patchAnchors"]
            with self.subTest(seams=seams):
                result = run_ingest(self.root, probe, "0.58.0", ANCHORS_044)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / "patch" / "manifests" / "0.58.0.json").exists())
                self.assertFalse((self.root / "compatibility" / "0.58.0-hosts.json").exists())

    def test_a_missing_installer_literal_writes_nothing(self):
        (self.root / "installer-windows" / "main.cjs").write_text("// no version list\n")
        result = run_ingest(self.root, make_probe(), "0.58.0", ANCHORS_044)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "patch" / "manifests" / "0.58.0.json").exists())
        supported = json.loads((self.root / "compatibility" / "supported-apps.json").read_text())
        self.assertEqual(supported["versions"], ["0.30.0", "0.44.0"])

    def test_ingest_refuses_an_existing_version(self):
        (self.root / "patch" / "manifests" / "0.58.0.json").write_text("{}")
        result = run_ingest(self.root, make_probe(), "0.58.0", ANCHORS_044)
        self.assertNotEqual(result.returncode, 0)

    def test_ingest_refuses_a_bad_digest(self):
        result = run_ingest(self.root, make_probe(sha="zzz"), "0.58.0", ANCHORS_044)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "patch" / "manifests" / "0.58.0.json").exists())

    def test_ingest_refuses_an_anchor_seen_twice(self):
        counts = {a: 1 for a in ANCHORS_044}
        counts[ANCHORS_044[0]] = 2
        result = run_ingest(self.root, make_probe(counts=counts), "0.58.0", ANCHORS_044)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "patch" / "manifests" / "0.58.0.json").exists())

    def test_ingest_refuses_a_non_stock_host(self):
        probe = make_probe(markers=[{"line": 4, "text": "GROKBOT_MODEL_ROUTER_V45"}])
        result = run_ingest(self.root, probe, "0.58.0", ANCHORS_044)
        self.assertNotEqual(result.returncode, 0)

    def test_ingest_refuses_a_probe_for_another_version(self):
        result = run_ingest(self.root, make_probe(), "0.59.0", ANCHORS_044)
        self.assertNotEqual(result.returncode, 0)


class AutoProbeTests(unittest.TestCase):
    """The unattended runner probe drafts support only for a proven new build."""

    # A 0.44.0-dialect host that names 0.61.0, like a real new build would.
    NEW_HOST = 'const appVersion = "0.61.0";\n' + patch_tests.MultiVersionManifestTests.NEW_SOURCE

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "repo"
        make_skeleton(self.root)
        # Shrink the newest shipped band so the small fixture host fits it.
        newest = self.root / "patch" / "manifests" / "0.44.0.json"
        manifest = json.loads(newest.read_text())
        manifest["anchorVerifiedHosts"].update({"minBytes": 100, "maxBytes": 100000})
        newest.write_text(json.dumps(manifest))
        self.host = Path(self.temporary.name) / "live-host.cjs"
        self.out = Path(self.temporary.name) / "out"

    def tearDown(self):
        self.temporary.cleanup()

    def run_probe(self, source: str, version: str = "0.61.0") -> dict:
        self.host.write_text(source)
        result = subprocess.run(
            [sys.executable, str(AUTO_PROBE_SCRIPT), "--version", version, "--host", str(self.host),
             "--root", str(self.root), "--out", str(self.out)],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.host.read_text(), source, "the live host must never change")
        return json.loads((self.out / "status.json").read_text())

    def test_new_build_is_proven_and_feeds_the_real_ingest(self):
        status = self.run_probe(self.NEW_HOST)
        self.assertEqual(status["status"], "ready", status["reason"])
        self.assertEqual(status["anchors"], ANCHORS_044)
        digest = hashlib.sha256(self.NEW_HOST.encode()).hexdigest()
        self.assertEqual(status["probe"]["sha256"], digest)
        # Public logs: the handoff carries no host source beyond the anchors.
        self.assertEqual(set(status["probe"]["candidates"]), {"routerMarker"})
        self.assertNotIn("sessionContext", status["probe"])
        self.assertNotIn("identityScope", status["probe"])
        self.assertFalse((self.root / "patch" / "manifests" / "0.61.0.json").exists())
        result = run_ingest(self.root, status["probe"], "0.61.0", status["anchors"])
        self.assertEqual(result.returncode, 0, result.stderr)
        written = json.loads((self.root / "patch" / "manifests" / "0.61.0.json").read_text())
        self.assertEqual(written["stockHosts"], [{"sha256": digest, "bytes": len(self.NEW_HOST.encode())}])

    def test_a_host_that_is_already_shipped_waits_for_the_box_to_update(self):
        newest = self.root / "patch" / "manifests" / "0.44.0.json"
        manifest = json.loads(newest.read_text())
        manifest["stockHosts"].append({
            "sha256": hashlib.sha256(self.NEW_HOST.encode()).hexdigest(),
            "bytes": len(self.NEW_HOST.encode())})
        newest.write_text(json.dumps(manifest))
        self.assertEqual(self.run_probe(self.NEW_HOST)["status"], "box-not-updated")

    def test_a_host_without_the_new_version_hint_is_refused(self):
        status = self.run_probe(patch_tests.MultiVersionManifestTests.NEW_SOURCE)
        self.assertEqual(status["status"], "version-unconfirmed")
        self.assertIsNone(status["probe"])

    def test_moved_anchors_are_never_guessed(self):
        moved = {
            "const mockResponse = options2.agentMockResponse;": "const mockResponse = readMock(options2);",
            "const extraction = await extractMemories({": "const extracted = await extractMemories({",
        }
        for anchor, replacement in moved.items():
            with self.subTest(anchor=anchor):
                status = self.run_probe(self.NEW_HOST.replace(anchor, replacement))
                self.assertEqual(status["status"], "anchors-moved")
                self.assertIn(anchor, status["reason"])
                self.assertEqual(status["anchors"], [])

    def test_a_patched_bot_computer_is_not_stock(self):
        status = self.run_probe(self.NEW_HOST + "// GROKBOT_MODEL_ROUTER_V45\n")
        self.assertEqual(status["status"], "not-stock")

    def test_anchors_that_count_once_but_do_not_patch_are_refused(self):
        source = self.NEW_HOST.replace(
            "createSession(onRequestId, sessionOptions) {\n",
            "createSession(onRequestId, sessionOptions) {\n      trace();\n")
        status = self.run_probe(source)
        self.assertEqual(status["status"], "patch-round-trip-failed")
        self.assertIsNone(status["probe"])


class ShippedGateConsistencyTests(unittest.TestCase):
    """supported-apps.json is the one list every shipped gate must agree with."""

    def test_manifests_and_installer_gates_agree(self):
        supported = json.loads((PROJECT_ROOT / "compatibility" / "supported-apps.json").read_text())["versions"]
        manifests = sorted(
            json.loads(path.read_text())["grokBotVersion"]
            for path in (PROJECT_ROOT / "patch" / "manifests").glob("*.json"))
        self.assertEqual(manifests, sorted(supported))
        swift = (PROJECT_ROOT / "installer" / "GrokBotRouterInstaller.swift").read_text()
        self.assertEqual(swift.split("GROK BOT ", 1)[1].split('"', 1)[0], " · ".join(supported))

    def test_delegation_floor_sits_above_every_adapter_version_and_matches_the_installer(self):
        apps = json.loads((PROJECT_ROOT / "compatibility" / "supported-apps.json").read_text())
        floor = apps["delegation"]["minimumVersion"]
        key = lambda value: tuple(int(part) for part in value.split("."))
        for version in apps["versions"]:
            self.assertGreater(key(floor), key(version))
        for version in apps["delegation"]["verifiedVersions"]:
            self.assertGreaterEqual(key(version), key(floor))
        installer = (PROJECT_ROOT / "remote" / "install-delegation.sh").read_text()
        self.assertIn(f'MINIMUM_GROK_VERSION="{floor}"', installer)
        self.assertNotIn("router_patch.py", installer)


if __name__ == "__main__":
    unittest.main()
