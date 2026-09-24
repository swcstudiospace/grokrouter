# Grok Bot version tracking

Grok Bot auto-updates; GrokRouter refuses any version without a manifest. This
pipeline closes that gap without ever loosening a gate. It has three stages;
only the last one is manual, and support is claimed only after the live gate.

## Stage 1 — detection (automatic)

`.github/workflows/version-watch.yml` runs daily and polls the official stable
feed for Apple-silicon Macs:

```bash
python3 scripts/check-grokbot-version.py --check
```

Exit `2` means the feed reports a version with no file in `patch/manifests/`.
The workflow then opens a tracking issue with the probe instructions below. It
never edits a manifest and never claims support.

You can run the same check by hand at any time; without `--check` it just
prints the JSON report and exits `0`.

## Stage 2 — scaffold (automatic, from a real probe)

A human with the new Grok Bot on a Mac selects any Bot, clicks
**Open computer**, and runs the read-only probe in the Bot terminal:

```bash
python3 scripts/host-probe.py \
  --anchor 'function createMockPromptExecutor(options2)' \
  --anchor 'createSession(onRequestId, sessionOptions)' \
  --anchor 'const mainSessionOptions = {' > /tmp/probe.txt
```

If an anchor counts anything other than exactly once, use the probe's
`candidates` lines to pick the replacement source line for the new build,
re-run with `--anchor '<exact line>'` for it, and confirm every chosen anchor
counts exactly once with an empty `candidates.routerMarker` (a non-empty
marker means the host is not stock — stop).

Paste the complete probe output into the **Ingest host probe** workflow
(dispatch inputs: `version`, `probe_json`, one reviewed anchor per line in
`anchors`), or run the same script locally:

```bash
python3 scripts/new-manifest-from-probe.py \
  --version <new version> --probe /tmp/probe.txt --anchor '<anchor>' ...
```

The script validates the probe (stock host, digest shape, size inside the
shipped policy band, version hint agreement, every anchor exactly once) and
then writes `patch/manifests/<version>.json` plus the installer version-list
updates (`GrokBotRouterInstaller.swift`, `install-macos.sh`,
`remote/install.sh`). It refuses to overwrite an existing manifest, refuses a
non-stock host, and reloads the written manifest through the same
`router_patch.load_manifest` gates as the shipped ones. The workflow runs the
patch tests and opens a **draft** PR with the do-not-merge checklist.

## Stage 3 — proof (manual, required)

Nothing is supported until a human completes, on the new version:

1. `npm test`.
2. The full fresh-Bot procedure in `docs/FRESH-BOT-ACCEPTANCE.md`
   (install → restore → reinstall → new Bot → `/router doctor` →
   `/provider` → one normal turn).
3. A `docs/TEST-MATRIX.md` row with the visible result and redacted audit
   receipt — code inspection alone never flips a row to Pass.
4. The README supported-version badge/message, only after the above pass.

## Design rules

- Detection and scaffolding are automatic; trust is not. No workflow merges,
  tags, or edits a manifest from anything but a reviewed live probe.
- Anchor strings are never invented. A version with moved source lines needs a
  new reviewed anchor set from probe candidates, not a reused old one.
- Size-band or policy changes are conscious edits, never auto-adjusted: the
  ingest fails outside the shipped band so a human reviews it.
