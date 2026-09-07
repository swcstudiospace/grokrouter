#!/usr/bin/env python3
"""Read-only compatibility probe for a Grok Bot cloud-computer host.

Run it inside the Bot terminal on a build GrokRouter does not support yet.
It reports the fingerprint and anchor status GrokRouter needs to add a new
manifest. It never modifies the host, never prints credentials, and prints at
most a few short lines of context per anchor so proprietary source is not
copied wholesale. Paste the output into a private chat, not a public issue.
"""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

HOST = Path(os.environ.get("ROUTER_PATCH_HOST", "/home/box/sand-host/host-main.cjs"))
REQUIRED_ANCHORS = [
    "function createMockPromptExecutor(options2)",
    "createSession(onRequestId, sessionOptions)",
    "const mockResponse = process.env.SAND_AGENT_MOCK_RESPONSE;",
    "const mainSessionOptions = {",
]
# When an exact anchor is missing, show the nearest candidates so the manifest
# can be updated without a copy of the host.
CANDIDATE_PATTERNS = {
    "executor": r"function create\w*PromptExecutor\(",
    "session": r"createSession\(",
    "mock": r"SAND_AGENT_MOCK_RESPONSE",
    "sessionOptions": r"const \w*[sS]essionOptions = \{",
    "boxId": r"resolveBoxId\(",
    "getModelId": r"getModelId",
    "routerMarker": r"GROKBOT_MODEL_ROUTER_V\d+|GROKBOT_ROUTER|OPENGROK",
}
MAX_LINES = 6
MAX_CHARS = 160


def version_hints(source: str) -> list[str]:
    found = set()
    for match in re.finditer(r'(?:appVersion|version|VERSION)["\']?\s*[:=]\s*["\'](\d+\.\d+\.\d+)["\']', source):
        found.add(match.group(1))
        if len(found) >= 8:
            break
    return sorted(found)


def main() -> int:
    if not HOST.is_file():
        print(json.dumps({"ok": False, "error": f"host not found at {HOST}"}))
        return 1
    data = HOST.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    source = data.decode("utf-8", errors="replace")
    lines = source.split("\n")
    report = {
        "ok": True,
        "host": str(HOST),
        "bytes": len(data),
        "sha256": digest,
        "lineCount": len(lines),
        "platform": os.uname().machine,
        "node": os.popen("node -v 2>/dev/null").read().strip(),
        "versionHints": version_hints(source),
        "anchors": {anchor: source.count(anchor) for anchor in REQUIRED_ANCHORS},
        "candidates": {},
    }
    for name, pattern in CANDIDATE_PATTERNS.items():
        matches = []
        for index, line in enumerate(lines):
            if re.search(pattern, line):
                matches.append({"line": index + 1, "text": line.strip()[:MAX_CHARS]})
                if len(matches) >= MAX_LINES:
                    break
        report["candidates"][name] = matches
    # Show the two lines that follow a createSession definition, because the
    # patch inserts its hook between that signature and the mock-response line.
    session_context = []
    for index, line in enumerate(lines):
        if re.search(r"createSession\(\w+, \w+\) \{", line):
            session_context.append([l.strip()[:MAX_CHARS] for l in lines[index:index + 3]])
            if len(session_context) >= 3:
                break
    report["sessionContext"] = session_context
    identity_context = []
    for index, line in enumerate(lines):
        if re.search(r"const \w*[sS]essionOptions = \{", line):
            identity_context.append([l.strip()[:MAX_CHARS] for l in lines[index:index + 3]])
            if len(identity_context) >= 3:
                break
    report["sessionOptionsContext"] = identity_context
    print("GROKROUTER_HOST_PROBE_BEGIN")
    print(json.dumps(report, indent=2))
    print("GROKROUTER_HOST_PROBE_END")
    return 0


if __name__ == "__main__":
    sys.exit(main())
