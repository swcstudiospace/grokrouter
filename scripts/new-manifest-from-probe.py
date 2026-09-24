#!/usr/bin/env python3
"""Scaffold a new Grok Bot version manifest from a real host-probe report.

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
report carries its exact count; each must appear exactly once. The script
writes patch/manifests/<version>.json and updates the hardcoded supported
version lists (Swift installer, install-macos.sh, remote/install.sh payload
check). The result is a draft: it still needs `npm test` and the full live
fresh-Bot gate in docs/FRESH-BOT-ACCEPTANCE.md before any support is claimed.
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


def replace_once(path: Path, pattern: str, replacement: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    matches = re.findall(pattern, text, flags=re.MULTILINE)
    if len(matches) != 1:
        raise ValueError(f"{label}: expected 1 match, found {len(matches)} in {path}")
    path.write_text(text.replace(matches[0], replacement, 1), encoding="utf-8")


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

    manifests_dir = root / "patch" / "manifests"
    existing = sorted(manifests_dir.glob("*.json"))
    if not existing:
        return fail(f"no manifests in {manifests_dir}")
    newest = max(existing, key=lambda p: tuple(int(n) for n in re.findall(r"\d+", p.stem)))
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
    if target.exists():
        return fail(f"{target} already exists; support for {version} is already scaffolded")
    manifest = {
        "grokBotVersion": version,
        "hostPath": template.get("hostPath", "/home/box/sand-host/host-main.cjs"),
        "stockHosts": [{"sha256": sha, "bytes": size}],
        "requiredAnchors": anchors,
        "routerMarker": template.get("routerMarker", "GROKBOT_MODEL_ROUTER_V45"),
        "anchorVerifiedHosts": policy,
    }
    target.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    # The written manifest must satisfy the same loader gates as shipped ones.
    spec = importlib.util.spec_from_file_location(
        "router_patch", root / "patch" / "router_patch.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    try:
        module.load_manifest(target)
    except Exception as error:
        target.unlink()
        return fail(f"generated manifest fails loader gates, removed: {error}")

    versions = sorted(
        [json.loads(p.read_text())["grokBotVersion"] for p in manifests_dir.glob("*.json")])
    try:
        swift = root / "installer" / "GrokBotRouterInstaller.swift"
        swift_list = "[" + ", ".join(f'"{v}"' for v in versions) + "]"
        replace_once(swift,
                     r"private let supportedGrokVersions = \[[^\]]*\]",
                     f"private let supportedGrokVersions = {swift_list}",
                     "supportedGrokVersions")
        replace_once(swift,
                     r"GROK BOT [0-9.]+(?: · [0-9.]+)*",
                     "GROK BOT " + " · ".join(versions),
                     "installer eyebrow")
        install_macos = root / "scripts" / "install-macos.sh"
        replace_once(install_macos,
                     r"install Grok Bot [0-9.]+(?: or [0-9.]+)* in Applications first",
                     "install Grok Bot " + " or ".join(versions) + " in Applications first",
                     "install-macos.sh gate message")
        remote_install = root / "remote" / "install.sh"
        remote_text = remote_install.read_text(encoding="utf-8")
        block_pattern = re.compile(
            r'(  "\$PAYLOAD_ROOT/patch/manifests/[0-9.]+\.json" \\\n)+')
        block_match = block_pattern.search(remote_text)
        if not block_match:
            raise ValueError("remote/install.sh manifest block not found")
        block = "".join(f'  "$PAYLOAD_ROOT/patch/manifests/{v}.json" \\\n' for v in versions)
        remote_install.write_text(
            remote_text[:block_match.start()] + block + remote_text[block_match.end():],
            encoding="utf-8")
    except (OSError, ValueError) as error:
        return fail(str(error))

    print(f"Drafted support for Grok Bot {version}:")
    print(f"  manifest: {target.relative_to(root)} (sha256 {sha[:12]}..., {size} bytes)")
    print(f"  supported versions now: {', '.join(versions)}")
    print("Next: run `npm test`, then the full live gate in docs/FRESH-BOT-ACCEPTANCE.md")
    print("before claiming support in docs/TEST-MATRIX.md.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
