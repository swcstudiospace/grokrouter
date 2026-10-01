# Phase 2: Reviewed Grok Bot 0.63.0 manifest - Context

**Gathered:** 2026-10-01
**Status:** Blocked
**Mode:** User decisions from this session

## Phase Boundary

Reviewed Grok Bot 0.63.0 manifest support. xAI and Anthropic oauth plans to be usable. Do not invent a host probe or change manifests. 0.63.0 DMG has no Bot-computer host.

## Implementation Decisions
- 0.30.0, 0.36.0, and 0.44.0 stay as the structural template until a 0.63.0 probe is ingested.
- xAI oauth stable (no edit). Anthropic post-phase1 stable no regression.
- Keep gates. No invented anchors/manifests. No live claims w/o Bot acceptance.
- Update only to reflect unit-verified oauth plans + accurate status.

## Deferred Ideas
- 0.63 blocker confirmed (no probe/DMG has no host, no manifest change allowed).
- Host probe required for reviewed support.
- Per contract/AGENTS.

## Clarifications (SPE-5944 n6)

Clarifs settled from n1 evidence and recommended defaults. No user ask.

- q2 (blocking): push target settled by evidence. `git remote -v` shows origin https://github.com/swcstudiospace/grokrouter.git (push); `git branch --show-current` = fix/claude-max-subscription. Pending changes: 4 files + new dir from autonomous (oauth verif + 0.63 planning). See https://github.com/swcstudiospace/grokrouter
- q1: Omp unrelated (recommended default)
- q3: localhost only (recommended default)
- q4: use repo defines for run (recommended default)

All clarifs settled or defaulted with evidence. Phase 2 remains blocked only on 0.63.0 host probe (unrelated to these clarifs).