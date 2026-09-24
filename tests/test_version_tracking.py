"""Version-tracking pipeline tests: feed check, probe ingest, gate consistency.

Covers scripts/check-grokbot-version.py and scripts/new-manifest-from-probe.py,
plus the standing contract that every shipped manifest version appears in the
hardcoded installer version lists (so a future scaffold cannot silently miss
one of them).
"""
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

SWIFT_SNIPPET = """\
private let supportedGrokVersions = ["0.30.0", "0.44.0"]
        let eyebrow = NSTextField(labelWithString: "GROK BOT 0.30.0 · 0.44.0")
"""
INSTALL_MACOS_SNIPPET = """\
[[ -d "/Applications/Grok Bot.app" ]] \\
  || fail "install Grok Bot 0.30.0 or 0.44.0 in Applications first"
"""
REMOTE_INSTALL_SNIPPET = """\
  "$PAYLOAD_ROOT/patch/manifests/0.30.0.json" \\
  "$PAYLOAD_ROOT/patch/manifests/0.44.0.json" \\
  "$PAYLOAD_ROOT/compatibility/0.30.0-hosts.json" \\
"""


def make_probe(version="0.58.0", sha="a" * 64, size=28264284,
               counts=None, markers=None, hints=None):
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
    (root / "installer").mkdir()
    (root / "installer" / "GrokBotRouterInstaller.swift").write_text(SWIFT_SNIPPET)
    (root / "scripts").mkdir()
    (root / "scripts" / "install-macos.sh").write_text(INSTALL_MACOS_SNIPPET)
    (root / "remote").mkdir()
    (root / "remote" / "install.sh").write_text(REMOTE_INSTALL_SNIPPET)


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

    def tearDown(self):
        self.temporary.cleanup()

    def run_check(self, *extra):
        return subprocess.run(
            [sys.executable, str(CHECK_SCRIPT), "--feed-url", self.feed.as_uri(),
             "--manifests", str(self.manifests), *extra],
            capture_output=True, text=True)

    def test_newer_feed_version_reports_unsupported(self):
        result = self.run_check("--check")
        self.assertEqual(result.returncode, 2)
        report = json.loads(result.stdout)
        self.assertEqual(report["feedVersion"], "0.58.0")
        self.assertFalse(report["supportedFeed"])

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

    def test_valid_probe_scaffolds_manifest_and_updates_gates(self):
        result = run_ingest(self.root, make_probe(), "0.58.0", ANCHORS_044)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.root / "patch" / "manifests" / "0.58.0.json").read_text())
        self.assertEqual(manifest["grokBotVersion"], "0.58.0")
        self.assertEqual(manifest["stockHosts"], [{"sha256": "a" * 64, "bytes": 28264284}])
        self.assertEqual(manifest["requiredAnchors"], ANCHORS_044)
        swift = (self.root / "installer" / "GrokBotRouterInstaller.swift").read_text()
        self.assertIn('["0.30.0", "0.44.0", "0.58.0"]', swift)
        self.assertIn("GROK BOT 0.30.0 · 0.44.0 · 0.58.0", swift)
        macos = (self.root / "scripts" / "install-macos.sh").read_text()
        self.assertIn("install Grok Bot 0.30.0 or 0.44.0 or 0.58.0 in Applications first", macos)
        remote = (self.root / "remote" / "install.sh").read_text()
        self.assertIn('"$PAYLOAD_ROOT/patch/manifests/0.58.0.json"', remote)

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


class ShippedGateConsistencyTests(unittest.TestCase):
    """Every shipped manifest version must appear in each hardcoded gate."""

    def test_manifests_and_installer_gates_agree(self):
        manifests_dir = PROJECT_ROOT / "patch" / "manifests"
        versions = sorted(
            json.loads(path.read_text())["grokBotVersion"]
            for path in manifests_dir.glob("*.json"))
        self.assertTrue(versions)
        swift = (PROJECT_ROOT / "installer" / "GrokBotRouterInstaller.swift").read_text()
        listed = re.findall(r'private let supportedGrokVersions = \[([^\]]*)\]', swift)
        self.assertEqual(len(listed), 1)
        for version in versions:
            self.assertIn(f'"{version}"', listed[0])
            self.assertIn(version, swift.split("GROK BOT ", 1)[1].split('"', 1)[0])
        macos = (PROJECT_ROOT / "scripts" / "install-macos.sh").read_text()
        for version in versions:
            self.assertIn(version, macos)
        remote = (PROJECT_ROOT / "remote" / "install.sh").read_text()
        for version in versions:
            self.assertIn(f'"$PAYLOAD_ROOT/patch/manifests/{version}.json"', remote)


if __name__ == "__main__":
    unittest.main()
