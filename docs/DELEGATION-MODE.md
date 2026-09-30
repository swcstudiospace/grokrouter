# Delegation mode (Grok Bot 0.63.0 and newer)

Delegation mode is how GrokRouter works on Grok Bot 0.63.0 and every later
version. It replaces the host adapter, which is kept only for Grok Bot
0.30.0–0.44.0 and is deprecated.

## Why the host adapter stopped working

The host adapter patched `/home/box/sand-host/host-main.cjs` inside the Bot
computer so that every chat turn's `createSession` created the router's
executor instead of Grok's. That only works while the Bot computer performs
chat inference. A live 0.63.0 check on 2026-09-30 showed the patched host
installed, verified, and running, every anchor present exactly once, and yet no
chat turn ever entered the seam: no `seam_hit` audit event, no routed turn, no
bridge error, while the stock model answered every message. The bundles next to
the host do not start during a turn and the desktop app carries no turn loop,
so on 0.62.0+ inference happens outside the Bot computer, which is now a tool
sandbox. There is no seam left to patch, and no manifest can restore one.

## What delegation mode does instead

Grok keeps running the conversation, its memory, and its own tools. GrokRouter
becomes a native command, `/route`, that Grok runs in the Bot computer:

1. Grok writes the task text verbatim to `/tmp/grokrouter-task.md` and runs
   `grokbot-router run --task-file /tmp/grokrouter-task.md`.
2. `runtime/delegate.mjs` reads the Bot's saved selection (provider, model,
   reasoning) and runs the task in `/workspace`:
   - **Anthropic**: a Claude Agent SDK session (`query`) with the selected
     model and effort, `permissionMode: bypassPermissions`, resumed across
     `/route` calls while the model is unchanged.
   - **Codex**: a Codex SDK thread (`startThread` / `resumeThread`) with the
     selected model and reasoning.
   - **OpenRouter** and **xAI**: an OpenAI-compatible chat loop with four local
     tools (`shell`, `read_file`, `write_file`, `list_dir`) executed by the
     runtime in `/workspace`, bounded by `--max-steps` (default 40) and a shell
     timeout.
3. The runner prints the provider's final report, a blank line, and the
   trailer `[GrokRouter <version> · <Provider> · <model> · <reasoning> · N steps · Ns]`.
   Grok relays that standard output verbatim; the trailer is how a user can
   tell which model did the work.

The six control commands (`/provider`, `/model`, `/models`, `/reasoning`,
`/router`, `/doctor`) are native commands too. Each runs
`grokbot-router control "/<command> <argument>"` and relays the receipt, so the
same per-Bot state, model catalogs, aliases, and receipts as the adapter apply.

Per-Bot state is keyed by `box:<hostname>` of the Bot computer (override with
`--bot` or `GROKBOT_ROUTER_BOT`), stored under `conversation-states/` in the
install root. The audit log (`audit.jsonl`, redacted) records
`delegation_start`, `delegation_ok`, `delegation_error`, and `control_turn`
events with `mode: "delegation"`. `grokbot-router logs` prints the tail.

## What it depends on

Delegation mode touches three things in the Bot computer, and nothing else:

| Dependency | Used for | If Grok Bot changes it |
| --- | --- | --- |
| A terminal in the Bot computer with Node.js 18+, npm, and python3 | Installing and running the runtime | Install fails in `PREFLIGHT` with the missing command named |
| `~/.grok/skills/<name>/SKILL.md` | Registering `/route` and the six controls as native commands | Commands stop appearing in chat; `grokbot-router doctor` still passes and `grokbot-router run` still works from the terminal |
| Grok running a skill's shell command and relaying its output | `/route` and the controls | Replies stop carrying the `[GrokRouter …]` trailer; the audit log stops recording `delegation_*` events |

The host file, its anchors, manifests, signed registries, the watchdog, and the
desktop installer's DevTools/noVNC transfer are not used.

## Install and upgrade

One line in the Bot terminal (options optional):

```bash
curl -fsSL https://raw.githubusercontent.com/swcstudiospace/grokrouter/main/scripts/install-bot.sh | bash -s -- --provider anthropic --anthropic-model claude-opus-5-5 --reasoning xhigh
```

`scripts/install-bot.sh` downloads the repository at `GROKROUTER_REF`
(default `main`) and runs `remote/install-delegation.sh`, which:

- validates the payload (`SHA256SUMS` when installing from a built payload);
- stages the runtime, the CLI, and the seven skills under
  `/home/box/sand-data/grokbot-router`, merging an existing `provider.json`
  and setting `mode: "delegation"`;
- installs the pinned Codex and Claude Agent SDKs only when those providers
  are enabled, reusing an identical previous `node_modules`;
- preserves `conversation-states/`, `audit.jsonl`, and credentials;
- stops a legacy adapter watchdog if one is running, without touching the host;
- links the skills into `~/.grok/skills` (a user-owned directory of the same
  name is left alone and reported) and `grokbot-router` into
  `/home/box/.local/bin` (and `/usr/local/bin` when writable);
- verifies both runtimes parse and that `grokbot-router bot` can read the
  configuration, rolling back to the previous runtime otherwise.

Running the same line again upgrades in place. `grokbot-router uninstall`
unregisters the commands and disables the router; the runtime stays for
recovery. The legacy `remote/install.sh` refuses nothing here, but it is not
run for 0.63.0+; `grokbot-router` reads `mode` from `provider.json` and never
invokes the patcher or host registry in delegation mode.

## When Grok Bot updates

Each Grok Bot release gets a live check, not a host probe. The daily version
watch opens a "needs a delegation-mode live check" issue for any feed version
at or above `delegation.minimumVersion` that is not yet in
`delegation.verifiedVersions` (`scripts/check-grokbot-version.py --check`
exits `3`).

Checklist, on a Mac with the new Grok Bot:

1. Open a Bot's computer and its terminal; run the one-line install (or
   re-run it over an existing install).
2. `grokbot-router doctor` in the terminal: `Delegation runner: OK`, every
   command `linked`, the expected credentials.
3. In the Bot's chat: `/router doctor`, `/provider`, then one
   `/route reply with exactly PONG and nothing else`. The reply must end with
   the `[GrokRouter …]` trailer naming the Bot's provider and model.
4. `grokbot-router logs`: a `delegation_start` and `delegation_ok` pair for
   that task, with the same provider and model.
5. Add the version to `delegation.verifiedVersions` in
   `compatibility/supported-apps.json`, record the result in
   `docs/TEST-MATRIX.md`, and update the README compatibility table.

If a step fails, the table above names which dependency moved. Fix the
runtime for it, add a test, and repeat the check; never reach for the host.

## Verifying the model is actually used

- Every `/route` report ends with the trailer, for example
  `[GrokRouter 0.1.0-beta.48 · Anthropic · claude-opus-5-5 · xhigh · 6 steps · 41s]`.
  A reply without it came from Grok itself.
- `grokbot-router logs` shows `delegation_start` / `delegation_ok` with the
  provider, model, reasoning, step count, and duration.
- `grokbot-router bot` (or `/provider` in chat) shows the Bot's active
  selection; `grokbot-router run --task "…" --json` shows the same fields the
  trailer is built from.
