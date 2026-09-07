# Three-provider expansion: OpenRouter catalog, Anthropic (Claude Agent SDK), xAI OAuth

Date: 2026-09-07. Status: approved-by-goal (the session goal directed work to proceed without a pause; review this spec and object before release).

## Goal

1. Let a Bot pick any OpenRouter model, including the free ones, instead of the six pinned IDs.
2. Add an **Anthropic** provider with a sign-in flow that uses a Claude subscription legitimately.
3. Add an **xAI** provider with the Grok subscription OAuth device flow (SuperGrok / X Premium+).

Everything stays per-Bot state, single-delivery, and behind the same version-gated seam. No credential is ever written to project files or logs.

## Research findings that shape the design

- **OpenRouter** publishes `GET https://openrouter.ai/api/v1/models` without auth. Today it returns ~430 models; ~21 carry `:free` suffixes or zero pricing. Each entry has `id`, `name`, `context_length`, `pricing.prompt/completion` (strings), `supported_parameters` (includes `tools`, `reasoning`).
- **Anthropic** prohibits Claude Free/Pro/Max OAuth tokens in third-party harnesses, but since May 2026 explicitly permits third-party apps to use a subscription through the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, currently 0.3.263), billed against a monthly "Agent SDK credit". The SDK bundles a platform `claude` binary that owns the login (`claude auth login`, `claude auth status`, `claude setup-token`). This mirrors exactly how the router already uses the Codex SDK plus `codex login --device-auth`. We therefore do **not** implement a raw claude.ai OAuth client; we drive the SDK's own sign-in.
- **xAI** launched first-class OAuth for coding agents in May 2026. Discovery at `https://auth.x.ai/.well-known/openid-configuration` lists the device-authorization endpoint `https://auth.x.ai/oauth2/device/code`, token endpoint `https://auth.x.ai/oauth2/token`, grant `urn:ietf:params:oauth:grant-type:device_code`, and PKCE/none client auth. The shared public desktop client (used by OpenClaw, Hermes, pi) is `b1a00492-073a-47ea-816f-4c329264a828` with scope `openid profile email offline_access grok-cli:access api:access`. Tokens are bearer tokens for the OpenAI-compatible `https://api.x.ai/v1/chat/completions`; subscription-quota models are served from `https://cli-chat-proxy.grok.com/v1` and listed at `.../v1/models` on each host.

## Architecture

The runtime keeps one file, `runtime/run-provider.mjs`, as the per-turn executor. Two new small modules keep it readable:

- `runtime/openrouter-catalog.mjs` — fetch, cache (1 h, file under the runtime directory, mode 0600), filter (`free`, search term), and format the live catalog.
- `runtime/xai-oauth.mjs` — device-code sign-in, credential file (`<runtime>/xai-oauth.json`, 0600), refresh with a 60 s skew, `x.ai`-origin guard so the bearer never leaves `api.x.ai` / `cli-chat-proxy.grok.com`.

Provider dispatch becomes a table: `codex`, `openrouter`, `anthropic`, `xai`. Each has a label, default model, default reasoning, configured model list, aliases, credential doctor line, and a `run*` function. `stateForTurn`, `/provider`, `/models`, `/model`, doctor, and the control help text read from that table rather than from `provider === "openrouter"` ternaries.

### OpenRouter catalog

- `/models` (no argument) still prints the pinned list, then a one-line hint: `Send /models free, /models all, or /models search <text> to browse the live OpenRouter catalog.`
- `/models free` prints every catalog model with `:free` or zero prompt+completion pricing, marking which support `tools`.
- `/models all` prints the catalog grouped by vendor, capped to keep a chat reply readable (page with `/models all 2`).
- `/models search <text>` filters `id` and `name` case-insensitively.
- `/model <id>` keeps accepting any `vendor/model` ID. When the catalog is available it warns (but still switches) if the ID is not listed, and it tells the user when a chosen model has no `tools` support so they know outer tools will be text-recovered.
- Aliases add `free` → `openrouter/free` (OpenRouter's rotating free router).
- Catalog fetch failures never break a control; the reply says the live catalog is unavailable and shows the pinned list.

### Anthropic provider (Claude Agent SDK)

- Dependency: `@anthropic-ai/claude-agent-sdk` pinned in `runtime/package.json`; the platform binary package is installed by `remote/install.sh` only when `anthropic` is in the enabled providers, exactly like the Codex native package.
- `runAnthropic` uses `query()` from the SDK with `permissionMode: "bypassPermissions"`, `cwd: config.workingDirectory`, `model`, `effort` (maps the router's minimal/low/medium/high/xhigh to the SDK's low/medium/high/xhigh/max), and the same structured JSON output contract the Codex adapter uses (`text` + bounded `toolCalls`) so outer Grok tools keep working through the structured adapter. Session resume uses the SDK `resume` option with the per-Bot `threadId`, reset by `/router reset` and by a model change, like Codex.
- Sign-in: `grokbot-router auth anthropic` execs the bundled binary's `auth login` inside the Bot terminal. The desktop installers get a `Start Anthropic Sign-in` button next to the Codex one. Doctor prints the redacted `auth status`.
- Default model `claude-sonnet-4-6`; configured list `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-fable-5-1` guarded by the SDK's own model validation (an unknown model surfaces as a provider error, not a crash).

### xAI provider (Grok OAuth)

- Sign-in: `grokbot-router auth xai` runs `node run-provider.mjs --xai-login`, which requests a device code, prints the verification URL and user code to the Bot terminal, polls the token endpoint honoring `interval`/`slow_down`, and stores `{access, refresh, expiresAt}` at 0600. No browser is opened from the cloud computer; the user opens the URL on their own device.
- `runXai` is an OpenAI-compatible chat-completions call reusing `openRouterMessages` conversion and the same native-plus-textual tool recovery. Base URL defaults to `https://api.x.ai/v1`; models found on the subscription proxy catalog are routed to `https://cli-chat-proxy.grok.com/v1`. A 401 triggers one refresh-and-retry; `invalid_grant` marks the credential dead and the reply tells the user to run the sign-in again.
- Default model `grok-4.6`; configured list from the router defaults plus the live authenticated catalog on `/models`.
- The stock Grok app's own inference is untouched; this provider only affects Bots that explicitly select `/provider xai`.

## Installer and helper surface

- `remote/grokbot-router`: `auth codex|anthropic|xai`, `provider codex|openrouter|anthropic|xai`, `model <provider> MODEL`, doctor lines for each credential.
- `remote/install.sh`: `--provider` / `--providers` accept the four IDs in any comma combination; dependency install runs when `codex` or `anthropic` is enabled; `--anthropic-model`, `--xai-model` flags.
- `patch/router_patch.py`: the host executor passes the provider through unchanged and falls back to the default model per provider from the table.
- macOS Swift installer and Windows Electron installer: two new provider checkboxes, two sign-in buttons, default-provider popup entries, and model popups fed from `runtime/provider.default.json`.
- Docs: README provider table, HOW-IT-WORKS, ARCHITECTURE, TEST-MATRIX (new rows start as *unverified* until a live fresh-Bot test).

## Error handling

- Every provider error is redacted through `redactDiagnostic` and audited as `turn_error`; token values are added to the redaction list.
- Catalog and OAuth network calls use `AbortSignal.timeout` (15 s for catalog, 30 s per poll).
- Missing credentials produce a one-line chat reply naming the exact sign-in command; they never fall back to another provider silently.

## Testing

- Unit tests in `tests/runtime.test.mjs`: catalog parsing and free filtering with a fixture; `/models free|all|search` replies; `/model` warnings; `/provider anthropic|xai` state; `runXai` request shape with an injected fetch, refresh-on-401, origin guard; `runAnthropic` with an injected query factory and structured output parsing; device-flow polling with `slow_down`.
- `tests/installer.test.sh` and `tests/test_patch.py`: provider validation for the four IDs.
- Live acceptance is recorded only after the fresh-Bot procedure per `docs/FRESH-BOT-ACCEPTANCE.md`.

## Out of scope

Raw claude.ai OAuth (prohibited by Anthropic's terms for third-party harnesses), streaming, Windows beginner path changes, and any change to the stock host hash or version gates.
