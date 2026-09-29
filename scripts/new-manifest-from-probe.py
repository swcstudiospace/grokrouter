#!/usr/bin/env python3
"""Scaffold support for a new Grok Bot version from a real host-probe report.

This is the second half of the version-tracking pipeline (the first half is
scripts/check-grokbot-version.py spotting a new release). It NEVER guesses:
every field comes from a read-only scripts/host-probe.py run on the untouched
stock host of the new Grok Bot version, reviewed by a human.

Usage (after pasting the probe output to /tmp/probe.json)::

  python3 scripts/new-manifest-from-probe.py \
    --version 0.58.0 --probe /tmp/probe.json \
    --anchor 'function createMockPromptExecutor(options2)' \
    --anchor 'createSession(onRequestId, sessionOptions)' \
    ...

Every --anchor must have been passed to host-probe.py as --anchor too, so the
report carries its exact count; each must appear exactly once, and so must
every patch seam in the probe's patchAnchors. The script writes the exact
per-version layout: patch/manifests/<version>.json (structural trust
disabled), compatibility/<version>-hosts.json (UNSIGNED), the version in
compatibility/supported-apps.json, and the installer version literals in the
Swift and Windows installers. The result is a draft: a maintainer must sign
the registry locally with scripts/sign-host-registry.mjs, and it still needs
`npm test` and the full live fresh-Bot gate in docs/FRESH-BOT-ACCEPTANCE.md
before any support is claimed.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def fail(message: str) -> int:
    print(f"new-manifest-from-probe: {message}", file=sys.stderr)
    return 1


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", version))


def load_probe(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    begin = text.find("GROKROUTER_HOST_PROBE_BEGIN")
    end = text.find("GROKROUTER_HOST_PROBE_END")
    if begin >= 0 and end > begin:
        text = text[begin + len("GROKROUTER_HOST_PROBE_BEGIN"):end]
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"probe file is not JSON: {error}") from error


def load_patcher(root: Path):
    spec = importlib.util.spec_from_file_location("router_patch", root / "patch" / "router_patch.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def replace_once(text: str, pattern: str, replacement: str, label: str) -> str:
    matches = re.findall(pattern, text, flags=re.MULTILINE)
    if len(matches) != 1:
        raise ValueError(f"{label}: expected 1 match, found {len(matches)}")
    return text.replace(matches[0], replacement, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="new Grok Bot version, e.g. 0.58.0")
    parser.add_argument("--probe", required=True, help="path to host-probe.py output")
    parser.add_argument("--anchor", action="append", default=[], help="required anchor (repeatable)")
    parser.add_argument("--root", default=str(ROOT))
    args = parser.parse_args()
    root = Path(args.root)

    version = args.version.strip()
    if not VERSION_RE.match(version):
        return fail(f"version {version!r} is not X.Y.Z")
    try:
        probe = load_probe(Path(args.probe))
    except (OSError, ValueError) as error:
        return fail(str(error))
    if not isinstance(probe, dict) or probe.get("ok") is not True:
        return fail("probe did not report ok:true; re-run host-probe.py on the stock host")
    hints = probe.get("versionHints") or []
    if hints and version not in hints:
        return fail(f"probe versionHints {hints} do not mention {version}; wrong probe output?")
    sha = str(probe.get("sha256", ""))
    if not SHA_RE.match(sha):
        return fail("probe sha256 is not a 64-char hex digest")
    size = probe.get("bytes")
    if not isinstance(size, int) or size <= 0:
        return fail("probe bytes is not a positive integer")

    anchors = [a for a in dict.fromkeys(args.anchor) if a.strip()]
    if len(anchors) < 3:
        return fail("pass at least 3 --anchor values reviewed from the probe candidates")
    counts: dict[str, int] = {}
    for section in ("anchors", "mockAnchors", "customAnchors"):
        section_data = probe.get(section) or {}
        if isinstance(section_data, dict):
            counts.update({str(k): v for k, v in section_data.items()})
    for anchor in anchors:
        if "\n" in anchor or not (8 <= len(anchor) <= 200):
            return fail(f"anchor {anchor!r} is not a plausible single source line")
        if anchor not in counts:
            return fail(f"anchor {anchor!r} has no probe count; re-run host-probe.py with --anchor {anchor!r}")
        if counts[anchor] != 1:
            return fail(f"anchor {anchor!r} appears {counts[anchor]} times, need exactly once")
    candidates = probe.get("candidates") or {}
    markers = candidates.get("routerMarker")
    if not isinstance(markers, list):
        return fail("probe lacks candidates.routerMarker; re-run the current host-probe.py")
    if markers:
        return fail(f"host already carries a router marker: {markers}; it is not stock")

    try:
        patcher = load_patcher(root)
    except Exception as error:
        return fail(f"cannot load patch/router_patch.py: {error}")
    # The patch hooks these seams in every version; the live probe must prove
    # them, not only the manifest anchors.
    seams = probe.get("patchAnchors")
    if not isinstance(seams, dict):
        return fail("probe lacks patchAnchors; re-run the current host-probe.py")
    for anchor in patcher.PATCH_ANCHORS:
        if seams.get(anchor) != 1:
            return fail(f"patch seam {anchor!r} appears {seams.get(anchor, 0)} times, need exactly once")

    manifests_dir = root / "patch" / "manifests"
    existing = sorted(manifests_dir.glob("*.json"))
    if not existing:
        return fail(f"no manifests in {manifests_dir}")
    newest = max(existing, key=lambda p: version_key(p.stem))
    template = json.loads(newest.read_text(encoding="utf-8"))
    if not isinstance(template.get("anchorVerifiedHosts"), dict):
        return fail(f"template manifest {newest} has no anchorVerifiedHosts policy")
    policy = template["anchorVerifiedHosts"]
    if not (isinstance(policy.get("minBytes"), int) and isinstance(policy.get("maxBytes"), int)):
        return fail(f"template manifest {newest} has a non-integer size band")
    if not policy["minBytes"] <= size <= policy["maxBytes"]:
        return fail(f"probe bytes {size} outside template size band "
                    f"[{policy['minBytes']}, {policy['maxBytes']}]; review the policy consciously")

    target = manifests_dir / f"{version}.json"
    registry_target = root / "compatibility" / f"{version}-hosts.json"
    supported_path = root / "compatibility" / "supported-apps.json"
    if target.exists() or registry_target.exists():
        return fail(f"support for {version} is already scaffolded ({target.name} or {registry_target.name} exists)")
    try:
        supported = json.loads(supported_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return fail(f"cannot read {supported_path}: {error}")
    listed = supported.get("versions") if isinstance(supported, dict) else None
    if not isinstance(listed, list) or version in listed:
        return fail(f"{supported_path} has no versions list or already lists {version}")
    versions = sorted({*listed, version}, key=version_key)
    stock_hosts = [{"sha256": sha, "bytes": size}]
    manifest = {
        "grokBotVersion": version,
        "hostPath": template.get("hostPath", "/home/box/sand-host/host-main.cjs"),
        "stockHosts": stock_hosts,
        "requiredAnchors": anchors,
        "routerMarker": template.get("routerMarker", "GROKBOT_MODEL_ROUTER_V45"),
        # A reviewed version trusts its exact stock hashes only; the band
        # bounds structural checks for a later unreviewed version.
        "anchorVerifiedHosts": {"enabled": False, "minBytes": policy["minBytes"], "maxBytes": policy["maxBytes"]},
    }
    registry = {"schemaVersion": 1, "grokBotVersion": version, "stockHosts": stock_hosts}

    # Prepare every gate edit before writing, so a missing literal changes nothing.
    swift_path = root / "installer" / "GrokBotRouterInstaller.swift"
    windows_path = root / "installer-windows" / "main.cjs"
    literal = json.dumps(versions)
    try:
        swift = replace_once(swift_path.read_text(encoding="utf-8"),
                             r"private let supportedGrokVersions = \[[^\]\n]*\]",
                             f"private let supportedGrokVersions = {literal}",
                             "Swift supportedGrokVersions")
        swift = replace_once(swift,
                             r"GROK BOT [0-9.]+(?: · [0-9.]+)*",
                             "GROK BOT " + " · ".join(versions),
                             "Swift installer eyebrow")
        windows = replace_once(windows_path.read_text(encoding="utf-8"),
                               r"const SUPPORTED_GROK_VERSIONS = \[[^\]\n]*\]",
                               f"const SUPPORTED_GROK_VERSIONS = {literal}",
                               "Windows SUPPORTED_GROK_VERSIONS")
    except (OSError, ValueError) as error:
        return fail(str(error))

    target.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    # The written manifest must satisfy the same loader gates as shipped ones.
    try:
        patcher.load_manifest(target)
    except Exception as error:
        target.unlink()
        return fail(f"generated manifest fails loader gates, removed: {error}")
    registry_target.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    supported["versions"] = versions
    supported_path.write_text(json.dumps(supported, indent=2) + "\n", encoding="utf-8")
    swift_path.write_text(swift, encoding="utf-8")
    windows_path.write_text(windows, encoding="utf-8")

    print(f"Drafted support for Grok Bot {version}:")
    print(f"  manifest: {target.relative_to(root)} (sha256 {sha[:12]}..., {size} bytes)")
    print(f"  registry: {registry_target.relative_to(root)} (UNSIGNED)")
    print(f"  supported versions now: {', '.join(versions)}")
    print("Next: a maintainer signs the registry locally (the private key never leaves")
    print(f"  ~/.config/grokrouter/release): node scripts/sign-host-registry.mjs {registry_target.relative_to(root)}")
    print("Then run `npm test` and the full live gate in docs/FRESH-BOT-ACCEPTANCE.md")
    print("before claiming support in docs/TEST-MATRIX.md.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
