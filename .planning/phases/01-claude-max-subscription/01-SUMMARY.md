# Phase 1: Claude Pro/Max subscription path - Summary

**Completed:** 2026-10-01

## Root cause

Model listing and turn billing were different paths. `/models` can show the packaged list, or `supportedModels()`, without starting a billed turn. The turn path copied the parent environment into the Claude Agent SDK, so an `ANTHROPIC_API_KEY` billed the API instead of the Pro/Max login. `permissionMode: bypassPermissions` fails when the process is root. Claude Code's own tools were left enabled, so a subscription turn could spend the plan on an agent loop instead of returning one structured object for Grok to execute.

This machine's Claude CLI was signed in as `subscriptionType=max` with rate-limit tier `default_claude_max_20x`. Extra usage was `out_of_credits`. The pinned SDK binary is Claude Code 2.1.263; the signed-in CLI is 2.1.278. Both saw the same login. A tools-disabled print turn reached `claude-sonnet-5` and was stopped by a local $0.10 budget. That is not a Bot-computer acceptance pass.

## What changed

- Turns strip API-key environment variables and keep `CLAUDE_CODE_OAUTH_TOKEN`.
- Claude Code tools, filesystem settings, and permission bypass are off. One structured reply. Grok still executes outer tools.
- Sign-in is `claude auth login --claudeai`. `setup-token` is the headless alternative.
- Doctor prints `signedIn`, `subscription`, `rateLimitTier`, and `extraUsage` only. Email and tokens are dropped.
- 0.63.0 is documented as the current feed version and still unreviewed.

## Verification

`npm run test:runtime`, `npm run test:patch`, `npm run test:windows`, and `npm run test:release` passed. `tests/installer.test.sh` failed before any of this change: this machine has `node` in `/usr/bin`, so the preflight fixture no longer hits `MISSING_COMMAND`.

## Not done

No reviewed 0.63.0 manifest. No fresh-Bot acceptance. Do not claim the Max plan is live-verified inside a Grok Bot computer.
