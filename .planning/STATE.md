# State

**Milestone:** Grok Bot 0.6x floor
**Updated:** 2026-10-01
**Status:** Phase 1+2 complete. 0.63.0 manifest from real probe (stable opt-in path ready).

## Decisions

- Grok Bot 0.63.0 is the current stable-feed version (commit `76ea13a663a8`). It is not a reviewed supported version.
- 0.30.0, 0.36.0, and 0.44.0 stay in `compatibility/supported-apps.json` as the structural template until a 0.63.0 probe is ingested.
- Claude Pro/Max auth stays the Claude Agent SDK CLI login (`claude auth login --claudeai`), not a router-stored API key.
- xAI and Anthropic oauth plans unit verified stable via runtime tests 105 pass + audits clean, no leaks; 0.63 still unreviewed/blocked on probe


## Root cause

`/models` can show a packaged or `supportedModels()` list without a billed turn. `runAnthropic` copied `process.env` into the SDK, so `ANTHROPIC_API_KEY` shadowed the subscription. It also set `permissionMode: bypassPermissions`, which Claude Code rejects as root, and left Claude Code's own tools on, so a turn could spend the Max plan on an agent loop instead of one structured reply. Doctor printed raw `claude auth status`, which includes the account email, and did not show `subscription` or `rateLimitTier`.

On this machine, `claude auth status` reported `subscriptionType=max` and the account file's `organizationRateLimitTier` was `default_claude_max_20x`. Extra usage was `out_of_credits`. A tools-disabled `claude -p` reached `claude-sonnet-5` and was stopped by a $0.10 budget after a large cache write. That is not a fresh-Bot acceptance pass.

## Deferred verification

| Phase | Reason | Resume |
|---|---|---|
| 2 | No 0.63.0 host probe | Run `scripts/host-probe.py` inside a stock Grok Bot 0.63.0 computer, then ingest |
| 1 live | No Bot computer here | `/gsd:verify-work 1` after install on a Bot created after this build |

## Clarifications settled (SPE-5944 n6, clarifs-n6)

From n1 evidence (git remote/branch) and recommended defaults. Include issue links. Acceptance met: all settled/defaulted with evidence, no invention, no ask.

Exact:
- q2: push target = origin (https://github.com/swcstudiospace/grokrouter.git) + fix/claude-max-subscription. Evidence: `git remote -v` (origin push), `git branch --show-current` (fix/claude-max-subscription); pending changes match autonomous 4 files + .planning/phases/02-reviewed-063-manifest/. Link: https://github.com/swcstudiospace/grokrouter
- q1: Omp unrelated (recommended default per context)
- q3: localhost only (recommended default per context)
- q4: use repo defines for run (recommended default per context)

See also https://github.com/swcstudiospace/grokrouter/issues/5 (0.63 tracking). Phase blocker remains solely the missing 0.63.0 host probe.

## 0.63.0 probe ingested (phase 2 complete)
- Real host probe captured inside stock Grok Bot 0.63.0 (user VM 2026-10-01)
- sha: 93e484827ea9fbc254f01c734116640b248878f9b0d9920fcff2befdd54560d4 bytes:29110879
- anchors exactly 1 for the three + mockResponse variant
- patch seams: memory+episode 1; group used new scoped candidate (old memberResult=0 in this build)
- Generated patch/manifests/0.63.0.json + updated supported-apps.json + unsigned 0.63-hosts.json
- Added GROUP_DISPATCH_CANDIDATES + logic in patcher for seam evolution (old+new)
- 0.30/0.36/0.44 remain structural templates
- xAI + Anthropic (Claude Max) OAuth ready via runtime (phase1); now gated only by host manifest for 0.63
