# Fresh-Bot release gate

This is the acceptance test. An existing Bot is not enough: create a brand-new Bot after installing the candidate build.

## Sixty-second control proof

1. Create a brand-new Bot in Grok Bot.
2. Wait for its automatic greeting. Confirm it is one short normal greeting with no router error, tool permission prompt, launch acknowledgement, or dynamic-tool activity in the audit.
3. Type `/` without sending. Filter by each name if the menu limits its initial results. Confirm the native suggestions include `provider`, `models`, `model`, `reasoning`, `router`, and `doctor`. For any missing entry, require an explicit user-skill conflict in the desktop installer's registration receipt; an unexplained missing entry fails.
4. Select `/doctor` from the menu and send it. Confirm the candidate router version and credential/runtime health. `/router doctor` must return the same health receipt. Separately run desktop **Check health** and verify the live host adapter and stock backup. In-chat Doctor does not inspect the adapter or native workflow registration.
5. Select `/models` from the menu and send it. Confirm the list ends with an explicit switch instruction.
6. Paste one catalog `vendor/model` ID by itself and send it. Repeat with an ID that is in the live catalog but outside the packaged shortlist (find one via `/models search`); it must switch with the same receipt shape.
7. Send `/provider`. Confirm the exact provider and model.
8. Ask `What provider and model are you using?` Confirm the answer agrees with `/provider` and does not deny the router controls.
9. Ask `Reply with exactly FRESH_BOT_TEXT_OK and nothing else.` Confirm one reply appears—no duplicate follow-up bubbles.
10. Create a second brand-new Bot and send `/provider`. Confirm it starts on the installer default instead of inheriting the first Bot's override.

Before release, also send `/Provider`, `/Router   Doctor`, `/router foo`, `/provider open router`, `/reasoning MAX`, and one unlisted `vendor/model` ID. Every input must return router status/help without a model-authored denial or invented answer.

`/models <id>` must also switch successfully because older demos and natural user behavior commonly use the plural command.

## Capability proof

In the same first Bot, prove each enabled provider with reversible, non-sensitive work:

- Create a small proof file with Grok's outer `Shell`, read it with outer `Read`, and verify the exact contents.
- Request a screenshot and identify one visible, non-sensitive window.
- Discover and run one small dynamic sub-agent task. Wait for the finished child's result to appear in the parent chat. A launch acknowledgement or `CheckSubagent` status alone is not a pass.
- For OpenRouter, inspect the first request/audit receipt: an explicit delegation request must force a supplied dedicated orchestration tool or `GetDynamicTools`. If the host supplied zero actionable schemas, the visible answer must state that limitation and must not claim a child started.
- After the child result appears, wait through the next host continuation and confirm the result is not inferred or delivered a second time.
- Inspect the redacted audit log and confirm the exact provider/model and expected tool names.
- Confirm every suppressed host continuation produces a redacted `turn_suppressed` receipt with a specific reason. A silent audit gap is a failure.
- Confirm provider tool-call IDs in the audit use the `grokbot-router-tool-` prefix instead of a provider-supplied raw identifier.

## Unreviewed-version install

Run this only on a Grok Bot strictly newer than every version in `compatibility/supported-apps.json`, on a Bot computer you are willing to restore. It is separate evidence and never makes that version reviewed.

1. With **Allow unreviewed Grok Bot version (experimental)** off, start installation. It must refuse the version, name the checkbox and `docs/VERSION-TRACKING.md`, and change nothing.
2. Confirm the checkbox changes nothing for a reviewed version (it still installs on its exact reviewed gate, with `HOSTTRUST=EXACT-ALLOWLIST`), and that an older or in-between unlisted version is still refused.
3. Turn the checkbox on and install. The log must say `UNREVIEWED VERSION`, name the template manifest it used, and report the stock backup. Desktop Doctor must report `HOSTTRUST=UNREVIEWED-ANCHOR-VERIFIED` and an `UNREVIEWED VERSION` line.
4. Complete the sixty-second control proof and the capability proof above in brand-new Bots.
5. **Restore Stock Grok Bot**, then confirm the live host's SHA-256 and byte count equal the fingerprint recorded before installation, and that the router is disabled.
6. If installation instead stops, confirm the host is unchanged and the report contains the full fingerprint with `PATCHANCHORS=` and `PATCHDRYRUN=`.

Record the version, template manifest, host fingerprint, and each result in `docs/TEST-MATRIX.md` as unreviewed-version evidence only.

## Windows

Windows is a preview until this passes natively on each claimed architecture (x64, Arm64):

1. On a clean Windows 10 or 11 account without Node.js or Git, run the pinned PowerShell command. It must list both `winget` lines and stop without changing anything.
2. Install the prerequisites, run the command again, and confirm GrokRouter is built for the right architecture, installed under `%LOCALAPPDATA%\Programs\GrokRouter`, added to the Start Menu, and opened, with no administrator prompt.
3. Run it a second time. It must replace the install and keep exactly one `GrokRouter.previous-<stamp>` folder.
4. Repeat from an extracted source ZIP with **Install GrokRouter.cmd**.
5. Complete install → **Restore stock** → reinstall, then the sixty-second control proof and capability proof in brand-new Bots, using **Check health** for the live adapter and stock backup.

## Release decision

The candidate fails if the automatic greeting invokes a tool or errors, any command reaches the model as ordinary chat, a response is delivered more than once, state leaks between Bots, a permission receipt fails to resume its outstanding tool call, the visible receipt disagrees with the audit, a background child finishes without reviving the parent, or a claimed tool path lacks a real live result.

Native slash discovery and deterministic command handling are separate acceptance checks. A menu entry proves only that Grok found the packaged skill descriptor; the exact control receipt and zero provider request prove that GrokRouter handled the command.
