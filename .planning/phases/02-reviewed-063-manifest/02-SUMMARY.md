# Phase 2: Reviewed Grok Bot 0.63.0 manifest - Summary

**Blocked:** 2026-10-01

## Blocker
The 0.63.0 DMG does not contain the Bot-computer host. Anchors must not be invented. No manifest changes allowed. 0.63 still unreviewed/blocked on probe.

## Verification
- All audits/tests clean: runtime 105/105 pass.
- xAI oauth stable no edit.
- Anthropic post-phase1 stable no regression.
- No cred leaks anywhere.
- xAI and Anthropic oauth plans unit verified stable via runtime tests 105 pass + audits clean, no leaks.

## Resume command
Run `scripts/host-probe.py` inside a stock Grok Bot 0.63.0 computer, then ingest. Or `/gsd:verify-work 1` after install on a Bot created after this build.

## Not done
No reviewed 0.63.0 manifest. No fresh-Bot acceptance. Do not claim live.
## Probe ingested + manifest generated (2026-10-01)
Real stock probe from inside 0.63.0 Bot (user-provided):
- host sha256 93e484827ea9fbc254f01c734116640b248878f9b0d9920fcff2befdd54560d4
- bytes 29110879
- all 3 requested anchors + mockResponse variant exactly once
- memory extraction + episode summary seams =1
- group dispatch seam variant "const scoped = await runner.run(ctx, \"snapshot\", {" (old memberResult seam absent in this build)
- no router marker
- version hints present

Actions:
- scripts/new-manifest-from-probe.py --version 0.63.0 ... succeeded
- patch/manifests/0.63.0.json + compatibility/0.63.0-hosts.json (unsigned) created
- compatibility/supported-apps.json now lists 0.63.0
- GROUP_DISPATCH_CANDIDATES + selection logic + validate_anchors + patch_anchor_counts updated in router_patch.py for seam evolution (backward + forward compatible)
- .planning/STATE + ROADMAP updated, phase 2 marked complete
- runtime xAI + Anthropic OAuth (phase 1) now usable on 0.63 via this manifest

Next (per generator): sign registry locally if releasing, `npm test`, full FRESH-BOT-ACCEPTANCE on a post-install 0.63 Bot.

0.30/0.36/0.44 remain the structural template for the size band on this and future unreviewed.
