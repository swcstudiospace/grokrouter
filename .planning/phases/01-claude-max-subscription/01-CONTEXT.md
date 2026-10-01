# Phase 1: Claude Pro/Max subscription path - Context

**Gathered:** 2026-10-01
**Status:** Ready for planning
**Mode:** User decisions from this session

## Phase Boundary

Fix the Anthropic path so a Claude Pro/Max subscription is what a turn uses. Do not invent a Grok Bot 0.63.0 manifest.

## Implementation Decisions

- Instrument first. No prior error log was available.
- Fix the Max path now. Keep 0.30.0, 0.36.0, and 0.44.0 as the structural template until a host probe exists.
- Auth remains `claude auth login --claudeai` / `setup-token`. The router does not store the token.

## Deferred Ideas

Reviewed 0.63.0 support. The desktop DMG has no host anchors.
