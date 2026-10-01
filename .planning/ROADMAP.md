# Roadmap: Grok Bot 0.6x floor

## Milestone

Move the maintained fork off treating 0.30.0–0.44.0 as the product target, and make Claude Pro/Max subscription turns actually bill the plan. Reviewed support for a new desktop version still requires a host probe. That probe does not exist for 0.63.0.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Claude Pro/Max subscription path | Complete |
| 2 | Reviewed Grok Bot 0.63.0 manifest | Blocked; oauth plans unit verified stable |

## Phase 1: Claude Pro/Max subscription path

Goal: a turn uses the signed-in Claude subscription, not an API key that happens to be in the environment, and doctor can say so without printing the account.

Success: unit tests prove API-key stripping, disabled Claude Code tools, and redacted billing status. Live Bot acceptance is not claimed.

## Phase 2: Reviewed Grok Bot 0.63.0 manifest

Goal: add `patch/manifests/0.63.0.json` and a signed registry from a real host probe, then retire 0.30.0/0.36.0/0.44.0 as the structural template.

Blocked: the 0.63.0 DMG does not contain the Bot-computer host. Anchors must not be invented. No manifest changes. xAI and Anthropic oauth plans unit verified stable via runtime tests (105/105 pass) + clean audits (no leaks). 0.63 still unreviewed/blocked on probe.
