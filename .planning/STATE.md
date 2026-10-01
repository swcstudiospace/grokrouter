# State

**Milestone:** Grok Bot 0.6x floor
**Updated:** 2026-10-01
**Status:** Phase 1 complete. Phase 2 blocked.

## Decisions

- Grok Bot 0.63.0 is the current stable-feed version (commit `76ea13a663a8`). It is not a reviewed supported version.
- 0.30.0, 0.36.0, and 0.44.0 stay in `compatibility/supported-apps.json` as the structural template until a 0.63.0 probe is ingested.
- Claude Pro/Max auth stays the Claude Agent SDK CLI login (`claude auth login --claudeai`), not a router-stored API key.

## Root cause

`/models` can show a packaged or `supportedModels()` list without a billed turn. `runAnthropic` copied `process.env` into the SDK, so `ANTHROPIC_API_KEY` shadowed the subscription. It also set `permissionMode: bypassPermissions`, which Claude Code rejects as root, and left Claude Code's own tools on, so a turn could spend the Max plan on an agent loop instead of one structured reply. Doctor printed raw `claude auth status`, which includes the account email, and did not show `subscription` or `rateLimitTier`.

On this machine, `claude auth status` reported `subscriptionType=max` and the account file's `organizationRateLimitTier` was `default_claude_max_20x`. Extra usage was `out_of_credits`. A tools-disabled `claude -p` reached `claude-sonnet-5` and was stopped by a $0.10 budget after a large cache write. That is not a fresh-Bot acceptance pass.

## Deferred verification

| Phase | Reason | Resume |
|---|---|---|
| 2 | No 0.63.0 host probe | Run `scripts/host-probe.py` inside a stock Grok Bot 0.63.0 computer, then ingest |
| 1 live | No Bot computer here | `/gsd:verify-work 1` after install on a Bot created after this build |
