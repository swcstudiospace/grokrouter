#!/usr/bin/env python3
"""Read-only compatibility probe for a Grok Bot cloud-computer host.

Run it inside the Bot terminal on a build GrokRouter does not support yet.
It reports the fingerprint and anchor status GrokRouter needs to add a new
manifest. It never modifies the host, never prints credentials, and prints at
most a few short lines of context per anchor so proprietary source is not
copied wholesale. Paste the output into a private chat, not a public issue.
"""
import argparse
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
# Mock-response anchor variants seen across supported versions. The probe
# always reports counts for every variant so a new build's dialect is visible
# without a second run.
KNOWN_MOCK_ANCHORS = [
    "const mockResponse = process.env.SAND_AGENT_MOCK_RESPONSE;",
    "const mockResponse = options2.agentMockResponse;",
]
# Seams the patch hooks in every version beyond the manifest anchors (group
# member dispatch, memory extraction, episode summary). Keep in step with
# PATCH_ANCHORS in patch/router_patch.py. Group dispatch has two dialects;
# exactly one must count once. This probe stays a single file so it can be
# copied into a Bot terminal on its own.
GROUP_DISPATCH_ANCHORS = [
    "const memberResult = await runner.run(promptForAttempt, {",
    "const memberResult = await this.tm.turnRuntime.runAgentTurn(",
]
PATCH_ANCHORS = [
    GROUP_DISPATCH_ANCHORS[0],
    "const extraction = await extractMemories({",
    "const narrative = await summarizeEpisode({",
]
# Grok Bot 0.62.0+ hosts drive turns through a newer loop. These count where
# that loop, its session factory, and the executor adapters live so a seam can
# be chosen for a build whose createSession hook is no longer on the path.
TURN_LOOP_ANCHORS = [
    "rootPromptExecutor.executeModelStreamOnly(",
    "function createCursorInferencePromptSession(options2)",
    "createCursorInferencePromptSession(",
    "inference.createSession(",
    "sanitizePromptSessionUsage(",
    "streamModelAndCollectToolCalls(",
    "var SimplePromptToolExecutor = class {",
    "var MockPromptExecutor = class extends BasePromptExecutor",
    "function executeModelStreamOnly(",
    "executorProfile",
    'require("node:fs")',
    "createRequire(",
]
# Other bundles a 0.6x Bot computer ships next to the host. Each is probed with
# the same counts so the report shows which file owns the turn loop.
EXTRA_BUNDLES = [
    Path("/home/box/sand-host/sand-eval-runner.cjs"),
    Path("/exec-daemon/index.js"),
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
    "groupDispatch": r"await runner\.run\(",
    "memoryExtraction": r"await extractMemories\(",
    "episodeSummary": r"await summarizeEpisode\(",
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


def node_processes() -> list[dict]:
    """Node processes and the bundle each one runs; arguments are cut short."""
    rows = []
    for line in os.popen("ps -eo pid,ppid,etimes,args 2>/dev/null").read().splitlines()[1:]:
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        pid, ppid, elapsed, args = parts
        if not re.search(r"(?:^|/)node(?:\s|$)|\.c?js\b", args):
            continue
        rows.append({"pid": int(pid), "ppid": int(ppid), "elapsedSeconds": int(elapsed), "args": args[:120]})
    return rows[:40]


def watch_processes(seconds: float) -> dict:
    """Sample the process table so a turn's helper processes become visible.

    Start the probe with --watch, then send the Bot one ordinary chat message
    from Grok Bot while it runs. Only processes that appear during the window
    are reported, with their arguments cut short.
    """
    import time

    def snapshot() -> dict[int, str]:
        table = {}
        for line in os.popen("ps -eo pid,args 2>/dev/null").read().splitlines()[1:]:
            parts = line.split(None, 1)
            if len(parts) == 2 and parts[0].isdigit():
                table[int(parts[0])] = parts[1][:120]
        return table

    known = snapshot()
    seen: dict[int, str] = {}
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for pid, args in snapshot().items():
            if pid not in known and pid not in seen and "ps -eo" not in args:
                seen[pid] = args
        time.sleep(0.25)
    return {"seconds": seconds, "started": [{"pid": pid, "args": args} for pid, args in sorted(seen.items())][:60]}


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Grok Bot host probe.")
    parser.add_argument("--anchor", action="append", default=[],
                        help="extra candidate anchor to count exactly (repeatable)")
    parser.add_argument("--bundle", action="append", default=[],
                        help="extra bundle file to count the turn-loop anchors in (repeatable)")
    parser.add_argument("--watch", type=float, default=0.0,
                        help="seconds to watch for node processes that start while you send the Bot one chat message")
    probe_args = parser.parse_args()
    if not HOST.is_file():
        print(json.dumps({"ok": False, "error": f"host not found at {HOST}"}))
        return 1
    data = HOST.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    source = data.decode("utf-8", errors="replace")
    lines = source.split("\n")
    extra = [anchor for anchor in dict.fromkeys(probe_args.anchor) if anchor]
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
        "mockAnchors": {anchor: source.count(anchor) for anchor in KNOWN_MOCK_ANCHORS},
        "patchAnchors": {
            anchor: source.count(anchor)
            for anchor in (*PATCH_ANCHORS, *GROUP_DISPATCH_ANCHORS)
        },
        "customAnchors": {anchor: source.count(anchor) for anchor in extra},
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
    # The identity hook references `boxId` and `rawTranscriptText`, which the
    # 0.30.0 host defines shortly before `mainSessionOptions`. Report only the
    # nearby lines that mention them so scope can be confirmed for a new build.
    scope_lines = []
    for index, line in enumerate(lines):
        if "const mainSessionOptions = {" in line:
            window = lines[max(0, index - 120):index]
            for offset, text in enumerate(window):
                if re.search(r"\b(boxId|rawTranscriptText|resolveBoxId|transcriptText)\b", text):
                    scope_lines.append({"line": index - len(window) + offset + 1, "text": text.strip()[:MAX_CHARS]})
            break
    report["identityScope"] = scope_lines[-12:]
    report["turnLoopAnchors"] = {anchor: source.count(anchor) for anchor in TURN_LOOP_ANCHORS}
    report["bundles"] = {}
    for bundle in [*EXTRA_BUNDLES, *(Path(item) for item in probe_args.bundle)]:
        if not bundle.is_file() or bundle == HOST:
            continue
        bundle_data = bundle.read_bytes()
        bundle_source = bundle_data.decode("utf-8", errors="replace")
        bundle_lines = bundle_source.split("\n")
        factory_context = []
        for index, line in enumerate(bundle_lines):
            if "createCursorInferencePromptSession(" in line and "function " not in line:
                factory_context.append([l.strip()[:MAX_CHARS] for l in bundle_lines[max(0, index - 2):index + 2]])
                if len(factory_context) >= 3:
                    break
        report["bundles"][str(bundle)] = {
            "bytes": len(bundle_data),
            "sha256": hashlib.sha256(bundle_data).hexdigest(),
            "versionHints": version_hints(bundle_source),
            "anchors": {anchor: bundle_source.count(anchor) for anchor in REQUIRED_ANCHORS},
            "patchAnchors": {anchor: bundle_source.count(anchor) for anchor in (*PATCH_ANCHORS, *GROUP_DISPATCH_ANCHORS)},
            "turnLoopAnchors": {anchor: bundle_source.count(anchor) for anchor in TURN_LOOP_ANCHORS},
            "customAnchors": {anchor: bundle_source.count(anchor) for anchor in extra},
            "sessionFactoryContext": factory_context,
        }
    report["processes"] = node_processes()
    if probe_args.watch > 0:
        report["watch"] = watch_processes(probe_args.watch)
    print("GROKROUTER_HOST_PROBE_BEGIN")
    print(json.dumps(report, indent=2))
    print("GROKROUTER_HOST_PROBE_END")
    return 0


if __name__ == "__main__":
    sys.exit(main())
