#!/usr/bin/env python3
"""Probe a live Grok Bot host unattended and decide whether support can be drafted.

Runs on the self-hosted GitHub Actions runner that lives inside a dedicated,
never-patched Grok Bot computer (see docs/VERSION-TRACKING.md). It is the
automatic form of the manual "run host-probe.py, review anchors, ingest" step:

1. Copy the live host byte-for-byte into --out; the live file is only read.
2. Run scripts/host-probe.py against the copy.
3. Accept the build only when every rule below holds; otherwise report why:
   - no router marker (the host is stock),
   - its SHA-256 is not already a shipped stock host (the Bot computer has
     really moved to a new build),
   - the probe's version hints name the requested version,
   - the executor, session, and session-options anchors plus exactly one known
     mock-response dialect each appear exactly once, and so do the patch's
     group-dispatch, memory-extraction, and episode-summary seams (only
     anchors the patcher already hooks; anchors are never invented or loosened),
   - the size sits inside the newest shipped manifest's policy band.
4. Scaffold the manifest in a scratch skeleton with new-manifest-from-probe.py
   and prove install -> restore round-trips on the copy with it (the real patch
   code, `node --check` included) and restores the exact stock bytes.

Workflow logs of a public repository are public, so nothing from the host
source is ever printed. --out receives status.json:
  {"status": "ready" | <reason code>, "reason": "...", "version": "...",
   "probe": <sanitized probe>, "anchors": [...]}
The sanitized probe carries only the digest, byte count, version hints, and
the selected and patch-seam anchor counts, which is what the ingest checks.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = Path(__file__).resolve().parent
SKELETON_FILES = (
    "patch/router_patch.py",
    "installer/GrokBotRouterInstaller.swift",
    "installer-windows/main.cjs",
    "compatibility/supported-apps.json",
)


def _load_host_probe():
    spec = importlib.util.spec_from_file_location("host_probe", SCRIPTS / "host-probe.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


HOST_PROBE = _load_host_probe()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def shipped_manifests(root: Path) -> list[dict]:
    manifests = []
    for path in sorted((root / "patch" / "manifests").glob("*.json")):
        manifests.append(json.loads(path.read_text(encoding="utf-8")))
    return manifests


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def run_quiet(command: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    # Output is captured and never echoed: it can quote host source.
    return subprocess.run(command, capture_output=True, text=True, env=env)


def select_anchors(probe: dict) -> tuple[list[str] | None, str]:
    counts = dict(probe.get("anchors") or {})
    mock_counts = dict(probe.get("mockAnchors") or {})
    patch_counts = dict(probe.get("patchAnchors") or {})
    mock_variants = list(HOST_PROBE.KNOWN_MOCK_ANCHORS)
    problems = []
    selected = []
    once_mocks = [anchor for anchor in mock_variants if mock_counts.get(anchor) == 1]
    stray_mocks = [anchor for anchor in mock_variants if mock_counts.get(anchor, 0) not in (0, 1)]
    if len(once_mocks) != 1 or stray_mocks:
        problems.append("mock-response dialect counts " + json.dumps(
            {anchor: mock_counts.get(anchor, 0) for anchor in mock_variants}))
    for anchor in HOST_PROBE.REQUIRED_ANCHORS:
        if anchor in mock_variants:
            if once_mocks and once_mocks[0] not in selected:
                selected.append(once_mocks[0])
            continue
        if counts.get(anchor) != 1:
            problems.append(f"{anchor!r} appears {counts.get(anchor, 0)} times")
        selected.append(anchor)
    for anchor in HOST_PROBE.PATCH_ANCHORS:
        if patch_counts.get(anchor) != 1:
            problems.append(f"patch seam {anchor!r} appears {patch_counts.get(anchor, 0)} times")
    if problems:
        return None, "; ".join(problems)
    return selected, ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", required=True, help="Grok Bot version the feed reports, e.g. 0.61.0")
    parser.add_argument("--host", default=os.environ.get("ROUTER_PATCH_HOST", str(HOST_PROBE.HOST)))
    parser.add_argument("--root", default=str(ROOT), help="repository root holding patch/manifests")
    parser.add_argument("--out", required=True, help="scratch directory for the copy and status.json")
    args = parser.parse_args()

    version = args.version.strip()
    root = Path(args.root)
    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    work = out / "work"
    work.mkdir()
    status: dict = {"status": "", "reason": "", "version": version, "probe": None, "anchors": []}

    def finish(code: str, reason: str) -> int:
        status["status"], status["reason"] = code, reason
        (out / "status.json").write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
        shutil.rmtree(work, ignore_errors=True)
        print(f"auto-probe {version}: {code}" + (f" - {reason}" if reason else ""))
        return 0

    live = Path(args.host)
    if not live.is_file():
        return finish("host-missing", f"no host at {live}; is the runner inside a Grok Bot computer?")
    host = work / "host-main.cjs"
    shutil.copyfile(live, host)

    env = dict(os.environ, ROUTER_PATCH_HOST=str(host))
    probed = run_quiet([sys.executable, str(SCRIPTS / "host-probe.py")], env=env)
    text = probed.stdout
    begin, end = text.find("GROKROUTER_HOST_PROBE_BEGIN"), text.find("GROKROUTER_HOST_PROBE_END")
    if probed.returncode or begin < 0 or end < begin:
        return finish("probe-failed", "host-probe.py did not produce a report")
    probe = json.loads(text[begin + len("GROKROUTER_HOST_PROBE_BEGIN"):end])

    manifests = shipped_manifests(root)
    if not manifests:
        return finish("probe-failed", f"no shipped manifests under {root / 'patch' / 'manifests'}")
    if (probe.get("candidates") or {}).get("routerMarker"):
        return finish("not-stock", "the runner's Bot computer carries a router marker; "
                      "restore stock Grok Bot there and never install GrokRouter on it")
    for manifest in manifests:
        if any(item.get("sha256") == probe["sha256"] for item in manifest.get("stockHosts", [])):
            return finish("box-not-updated", "the Bot computer still runs the shipped "
                          f"{manifest['grokBotVersion']} stock host; open Grok Bot {version} so it moves")
    hints = [str(hint) for hint in probe.get("versionHints") or []]
    if version not in hints:
        return finish("version-unconfirmed", f"host version hints {hints} do not name {version}")
    anchors, problem = select_anchors(probe)
    if anchors is None:
        return finish("anchors-moved", f"{problem}; pick replacement anchors from a manual probe")
    newest = max(manifests, key=lambda item: version_key(item["grokBotVersion"]))
    band = newest.get("anchorVerifiedHosts") or {}
    size = probe["bytes"]
    if not (band.get("minBytes", 0) <= size <= band.get("maxBytes", 0)):
        return finish("size-outside-band", f"host is {size} bytes, outside the "
                      f"{newest['grokBotVersion']} band [{band.get('minBytes')}, {band.get('maxBytes')}]")

    sanitized = {
        "ok": True,
        "bytes": size,
        "sha256": probe["sha256"],
        "versionHints": hints,
        "anchors": {},
        "mockAnchors": {},
        "patchAnchors": {anchor: 1 for anchor in HOST_PROBE.PATCH_ANCHORS},
        "customAnchors": {anchor: 1 for anchor in anchors},
        "candidates": {"routerMarker": []},
    }
    skeleton = out / "skeleton"
    shutil.copytree(root / "patch" / "manifests", skeleton / "patch" / "manifests")
    for relative in SKELETON_FILES:
        (skeleton / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / relative, skeleton / relative)
    probe_path = out / "probe.json"
    probe_path.write_text(json.dumps(sanitized, indent=2) + "\n", encoding="utf-8")
    scaffold = [sys.executable, str(SCRIPTS / "new-manifest-from-probe.py"), "--version", version,
                "--probe", str(probe_path), "--root", str(skeleton)]
    for anchor in anchors:
        scaffold += ["--anchor", anchor]
    if run_quiet(scaffold).returncode:
        return finish("scaffold-failed", "new-manifest-from-probe.py rejected the sanitized probe")

    manifest = skeleton / "patch" / "manifests" / f"{version}.json"
    patcher = [sys.executable, str(skeleton / "patch" / "router_patch.py"), "--host", str(host),
               "--backup", str(work / "backup" / "host-main.cjs.stock"), "--manifest", str(manifest), "--json"]
    for step, extra, expected in (("install", [], "installed"), ("restore", ["--restore"], "restored")):
        result = run_quiet(patcher + extra)
        try:
            outcome = json.loads(result.stdout).get("status")
        except json.JSONDecodeError:
            outcome = None
        if result.returncode or outcome != expected:
            return finish("patch-round-trip-failed", f"router_patch.py {step} did not report {expected}")
    if sha256(host) != probe["sha256"]:
        return finish("patch-round-trip-failed", "restore did not return the exact stock bytes")

    status["probe"] = sanitized
    status["anchors"] = anchors
    return finish("ready", "")


if __name__ == "__main__":
    sys.exit(main())
