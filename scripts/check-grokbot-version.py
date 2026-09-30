#!/usr/bin/env python3
"""Poll the official Grok Bot update feed and compare with supported manifests.

Read-only. Prints a JSON report to stdout:
  {"feedVersion": "0.58.0", "supported": ["0.30.0", "0.44.0"],
   "supportedFeed": false, "mode": "adapter", "commitSha": "...", "downloadUrl": "..."}

Two support tracks exist. Versions below the delegation floor recorded in
compatibility/supported-apps.json ("delegation.minimumVersion") belong to the
deprecated host adapter and are supported only with a manifest. Versions at or
above the floor belong to delegation mode and are supported once a live check
records them in "delegation.verifiedVersions".

Exit codes:
  0 - the feed version is supported on its track, or --check was not used.
  2 - an adapter-track version has no manifest (used with --check in CI).
  3 - a delegation-track version has not had its live check yet (--check).
  1 - any error (network, malformed feed, no manifests on disk).

Only stdlib is used so this runs on any CI runner and Mac without deps.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

FEED_URL = "https://api2.cursor.sh/updates/api/download/stable/darwin-arm64/sand"
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
TIMEOUT_SECONDS = 30


def manifest_versions(manifests: Path) -> list[str]:
    versions = []
    for candidate in sorted(manifests.glob("*.json")):
        try:
            versions.append(json.loads(candidate.read_text())["grokBotVersion"])
        except Exception:
            continue
    return versions


def version_key(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("."))


def delegation_support(supported_apps: Path) -> dict:
    try:
        block = json.loads(supported_apps.read_text()).get("delegation") or {}
    except Exception:
        return {}
    minimum = str(block.get("minimumVersion", ""))
    if not VERSION_RE.match(minimum):
        return {}
    verified = [str(item) for item in block.get("verifiedVersions", []) if VERSION_RE.match(str(item))]
    return {"minimumVersion": minimum, "verifiedVersions": sorted(verified, key=version_key)}


def fetch_feed_version(feed_url: str) -> tuple[str, dict]:
    request = urllib.request.Request(feed_url, headers={"User-Agent": "grokrouter-version-watch"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))
    version = str(payload.get("version", ""))
    if not VERSION_RE.match(version):
        raise ValueError(f"feed returned an unusable version: {version!r}")
    return version, payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feed-url", default=FEED_URL)
    parser.add_argument("--manifests", default=str(Path(__file__).resolve().parents[1] / "patch" / "manifests"))
    parser.add_argument("--supported-apps", default=str(Path(__file__).resolve().parents[1] / "compatibility" / "supported-apps.json"))
    parser.add_argument("--check", action="store_true",
                        help="exit 2 when the feed version has no manifest")
    args = parser.parse_args()

    manifests = Path(args.manifests)
    supported = manifest_versions(manifests)
    if not supported:
        print(f"No compatibility manifest found in {manifests}", file=sys.stderr)
        return 1
    try:
        feed_version, payload = fetch_feed_version(args.feed_url)
    except Exception as error:
        print(f"Could not read the Grok Bot update feed: {error}", file=sys.stderr)
        return 1
    delegation = delegation_support(Path(args.supported_apps))
    delegated = bool(delegation) and version_key(feed_version) >= version_key(delegation["minimumVersion"])
    report = {
        "feedVersion": feed_version,
        "supported": sorted(supported),
        "mode": "delegation" if delegated else "adapter",
        "delegation": delegation,
        "supportedFeed": feed_version in delegation["verifiedVersions"] if delegated else feed_version in supported,
        "commitSha": payload.get("commitSha", ""),
        "downloadUrl": payload.get("downloadUrl", ""),
    }
    print(json.dumps(report, indent=2))
    if args.check and not report["supportedFeed"]:
        return 3 if delegated else 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
