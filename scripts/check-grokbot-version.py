#!/usr/bin/env python3
"""Poll the official Grok Bot update feed and compare with supported manifests.

Read-only. Prints a JSON report to stdout:
  {"feedVersion": "0.58.0", "supported": ["0.30.0", "0.44.0"],
   "supportedFeed": false, "commitSha": "...", "downloadUrl": "..."}

Exit codes:
  0 - the feed version already has a manifest, or --report was used.
  2 - the feed reports a version with no manifest (used with --check in CI).
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
    report = {
        "feedVersion": feed_version,
        "supported": sorted(supported),
        "supportedFeed": feed_version in supported,
        "commitSha": payload.get("commitSha", ""),
        "downloadUrl": payload.get("downloadUrl", ""),
    }
    print(json.dumps(report, indent=2))
    if args.check and feed_version not in supported:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
