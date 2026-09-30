<p align="center">
  <img src="installer/Assets/grokbot-router-mascot-1024.png" width="176" alt="GrokRouter mascot wearing a black snapback">
</p>

<h1 align="center">GrokRouter</h1>

<p align="center">
  <strong>Bring your own model to Grok Bot.</strong><br>
  Route the official Grok Bot desktop app through the Codex SDK, OpenRouter, Anthropic, or xAI<br>
  without giving up its chat, Bots, files, computer, or tool boundary.
</p>

<p align="center">
  <img alt="Experimental project" src="https://img.shields.io/badge/status-experimental-ff6b2c?style=flat-square">
  <img alt="Grok Bot 0.30.0, 0.36.0 and 0.44.0" src="https://img.shields.io/badge/Grok_Bot-0.30.0_%7C_0.36.0_%7C_0.44.0-171717?style=flat-square">
  <img alt="Grok Bot 0.63.0 and newer: delegation mode" src="https://img.shields.io/badge/Grok_Bot_0.63.0%2B-delegation_mode-1f7a3a?style=flat-square">
  <img alt="Grok Bot 0.61.0 experimental opt-in" src="https://img.shields.io/badge/Grok_Bot_0.61.0-experimental_opt--in-8a6d00?style=flat-square">
  <img alt="macOS Apple silicon" src="https://img.shields.io/badge/macOS-Apple_silicon-111111?style=flat-square&logo=apple">
  <img alt="Windows x64 and Arm64 preview" src="https://img.shields.io/badge/Windows-x64_%7C_Arm64_preview-0078d4?style=flat-square&logo=windows11">
</p>

> [!IMPORTANT]
> **Maintained fork, `0.1.0-beta.48` candidate.** This is `swcstudiospace/grokrouter`, the maintained fork of GrokRouter. Beta.48 merges upstream beta.47 and keeps the fork's providers, model discovery, and version tracking. It is pending live acceptance; the last live-accepted evidence is beta.47 on Grok Bot 0.30.0 and 0.36.0. See the [verification matrix](docs/TEST-MATRIX.md).

GrokRouter was created by Prompt Advisers ([promptadvisers/grokrouter](https://github.com/promptadvisers/grokrouter)); this fork credits that work and is installed only from `swcstudiospace/grokrouter`.

## What it does

You keep using the normal Grok Bot app. GrokRouter lets each Bot use a different AI model for its thinking: the Codex SDK, any OpenRouter model (including the free ones), a Claude subscription through the Claude Agent SDK, or a Grok subscription through xAI's own sign-in.

| You keep | You choose |
| --- | --- |
| Grok Bot's desktop app and chat | Codex SDK, OpenRouter, Anthropic, or xAI |
| Existing Bots and conversations | A different provider per Bot |
| Cloud computer, files, browser, and permissions | A different model and reasoning level per Bot |
| Grok's outer tool-execution boundary | Stock Grok again at any time |

Grok Bot still owns conversations, files, the computer, permissions, and the tools it offers the routed model. Native maintenance sessions such as memory synthesis keep Grok's original inference backend. **Restore Stock Grok Bot** puts the verified original inference path back.

GrokRouter has two modes. **Delegation mode** is the current design for Grok Bot 0.63.0 and newer. The **host adapter** below it is the original design for Grok Bot 0.30.0–0.44.0; it is deprecated and receives no new version support.

## Grok Bot 0.63.0 and newer: delegation mode

Grok Bot 0.62.0 moved chat inference out of the Bot computer, so a host adapter has nothing to intercept there. From 0.63.0 GrokRouter runs in delegation mode: Grok keeps running the conversation and its own tools, and a native `/route` command hands a task to the provider you chose for that Bot (Codex, OpenRouter, Anthropic, or xAI). The provider works inside the Bot computer's `/workspace` with its own shell, file, and agent tools, and its report comes back into the chat verbatim with a `[GrokRouter …]` trailer naming the provider, model, reasoning level, and step count that produced it. Nothing on the Bot computer's host is read or modified, so there is no host probe, manifest, registry, or watchdog.

### Install

1. In Grok Bot, open the Bot's computer and its Terminal.
2. Paste one line. This example makes Anthropic's Claude Opus 5.5 at `xhigh` reasoning the default; every option is optional.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/swcstudiospace/grokrouter/main/scripts/install-bot.sh | bash -s -- --provider anthropic --anthropic-model claude-opus-5-5 --reasoning xhigh
   ```

3. Sign in to the providers you enabled, in the same terminal: `grokbot-router auth anthropic`, `grokbot-router auth codex`, or `grokbot-router auth xai`. OpenRouter reads `OPENROUTER_API_KEY` from Grok Bot's Secrets.
4. In the Bot's chat, send `/router doctor`, then `/route <task>`.

Options: `--provider`, `--providers codex,openrouter,anthropic,xai`, `--codex-model`, `--openrouter-model vendor/model`, `--anthropic-model`, `--xai-model`, `--reasoning minimal|low|medium|high|xhigh`, `--workspace DIR`, `--grok-version X.Y.Z`. `GROKROUTER_REF=<tag or branch>` in front of the command installs a version other than `main`. Running the same line again upgrades in place and keeps every Bot's selections, provider threads, and audit log.

### Use it

| Command | What it does |
| --- | --- |
| `/route <task>` | Delegate the task to this Bot's provider and relay its report. Grok may also invoke it itself for tasks that belong to the delegated model. |
| `/provider`, `/model`, `/models`, `/reasoning`, `/router`, `/doctor` | The same controls as in the [Use it](#use-it) table; each runs `grokbot-router control` in the Bot computer and relays its receipt. |

To confirm which model did the work: every `/route` report ends with `[GrokRouter <version> · Anthropic · claude-opus-5-5 · xhigh · N steps · Ns]`; `grokbot-router logs` in the Bot terminal shows the `delegation_start` and `delegation_ok` events with the same provider and model; `/router doctor` shows the Bot's active selection. A reply without the trailer came from Grok itself.

In the Bot computer:

```bash
grokbot-router status | doctor | bot | logs
grokbot-router run --task "…"                  # exactly what /route runs
grokbot-router control "/model claude-opus-5-5"
grokbot-router disable | enable
grokbot-router uninstall                       # unregister the commands; nothing on the host to restore
```

### When Grok Bot updates

Delegation mode depends only on the Bot computer's terminal, Node.js, and `~/.grok/skills`, so a new Grok Bot version needs a live check rather than a host probe. Each checked release is recorded in `compatibility/supported-apps.json` under `delegation.verifiedVersions`; [docs/DELEGATION-MODE.md](docs/DELEGATION-MODE.md) has the checklist and the design.

## Compatibility

Every Grok Bot desktop version is a separate gate. A version is reviewed only from a host probe run inside a Bot computer on that version: the Bot-computer host is not in the desktop download (the 0.61.0 DMG's `app.asar` contains no host anchors).

| Grok Bot | Status | Evidence |
| --- | --- | --- |
| 0.30.0 | Supported | Exact reviewed host. All seven live gates passed on Mac in upstream beta.47 (September 9, 2026). |
| 0.36.0 | Supported | Exact reviewed host. All seven live gates passed on Mac in upstream beta.47 (September 9, 2026). |
| 0.44.0 | Reviewed host, live acceptance pending | Exact host hash and byte count from a live probe on 2026-09-07, with a signed registry. Beta.47 added three mandatory patch seams (group member dispatch, memory-extraction executor, episode-summary executor) that no 0.44.0 probe has proven yet, and no fresh-Bot acceptance has run. |
| 0.58.0, 0.59.1, 0.61.0 | Not reviewed; [experimental opt-in](#unreviewed-grok-bot-versions) only | Shipped on the stable feed (0.61.0 is current for Mac arm64 and Windows x64/arm64). No host probe has been reviewed and no live run has been recorded. |
| 0.63.0 and newer | Supported in [delegation mode](#grok-bot-0630-and-newer-delegation-mode) | Verified: 0.63.0. A live 0.63.0 probe (2026-09-30) showed every host anchor present and the patched host running, yet chat turns never enter the host's `createSession` seam: the Bot computer no longer performs chat inference on these builds, so the adapter routes nothing there. Delegation mode replaces it and never touches the host. |
| 0.62.0 | Not supported | Same host behaviour as 0.63.0; delegation mode starts at 0.63.0, the first version it was checked on. |
| Any other version | Refused | Older and in-between versions are always refused, even with the opt-in. |

| Component | Current boundary |
| --- | --- |
| macOS | Apple silicon, macOS 12+, Xcode Command Line Tools. Live-verified in beta.47. |
| Windows 10/11 x64 and Arm64 | Preview. CI builds both architectures and now smoke-runs the source installer twice for idempotency; that job has not run yet. Native Windows live acceptance has never run. |
| Codex SDK | Sign in with your existing Codex account in the Bot computer |
| OpenRouter | Your OpenRouter API key; usage is billed by OpenRouter |
| Anthropic | Claude Pro or Max subscription through the Claude Agent SDK; live run pending |
| xAI | SuperGrok or X Premium+ device sign-in; live run pending |
| Computer and sub-agents | Available only when Grok offers the necessary schemas; see the [verification matrix](docs/TEST-MATRIX.md) for provider-specific evidence |

The desktop version and the cloud host are separate checks. A supported app can still receive an unknown host, which the installer leaves untouched. See [compatibility reports](https://github.com/swcstudiospace/grokrouter/issues?q=is%3Aissue+is%3Aopen+label%3Acompatibility).

## Legacy host adapter (Grok Bot 0.30.0–0.44.0, deprecated)

Everything from here to [Use it](#use-it) describes the original host-adapter design: a desktop app patches the Bot computer's inference host so that chat turns are routed before they reach Grok's model. It only works on Grok Bot 0.30.0, 0.36.0, and 0.44.0, it is kept for those versions, and it will not be extended to newer ones. On Grok Bot 0.63.0 or newer use [delegation mode](#grok-bot-0630-and-newer-delegation-mode) instead.

## Install on a Mac

You need an Apple-silicon Mac on macOS 12 or later, the official Grok Bot app in `/Applications`, and at least one of: a Codex account, an OpenRouter key beginning with `sk-or-v1-`, a Claude Pro/Max subscription, or a SuperGrok/X Premium+ subscription.

1. Open Grok Bot. Select a Bot, click **Open computer**, and leave it visible.
2. Paste this into your **Mac's Terminal** and press Return:

   ```bash
   /usr/bin/curl --fail --silent --show-error --location https://raw.githubusercontent.com/swcstudiospace/grokrouter/source-v0.1.0-beta.48/scripts/install-macos.sh --output /tmp/grokrouter-install.sh && /bin/bash /tmp/grokrouter-install.sh
   ```

   It downloads the tagged source, builds and signs the app locally, installs it at `~/Applications/GrokRouter.app`, and opens it. A previous GrokRouter app is moved to the Trash. It does not use `sudo`. If Xcode Command Line Tools are missing, the script opens Apple's installer; let it finish and run the same command again.

   The `source-v0.1.0-beta.48` tag is created only after live acceptance. Until it exists, the command above returns 404; build from a clone instead:

   ```bash
   git clone https://github.com/swcstudiospace/grokrouter.git && cd grokrouter && bash scripts/install-macos.sh
   ```

3. Choose your providers and the default for new Bots:

   | What you have | What to select |
   | --- | --- |
   | A Codex account | **Codex SDK**. Click **Start Codex Sign-in** after installation. |
   | An OpenRouter key | **OpenRouter**, and paste the complete `sk-or-v1-...` key. It goes to Grok Bot's protected Secrets store and the field is cleared. |
   | A Claude Pro or Max subscription | **Anthropic**. Click **Start Anthropic Sign-in** after installation. The Claude Agent SDK's own sign-in runs in the Bot terminal; GrokRouter never sees a claude.ai token. |
   | A SuperGrok or X Premium+ subscription | **xAI**. Click **Start xAI Sign-in**, open the link on any device, and confirm the code. |

   The model fields accept any well-formed model ID. Type one or pick a suggestion.
4. Click **Install Router**. Wait for a log line beginning with `✓ Installed`. Do not close Grok Bot or GrokRouter.
5. Create a **brand-new Bot after installation**. Type these into its normal chat, one at a time:

   ```text
   /router doctor
   /provider
   ```

   Doctor must identify the installed router and report runtime and credential health. `/provider` must name the provider and model you selected. Send a normal message and check it produces one answer. Use **Run Doctor** in the GrokRouter app to verify the live host adapter and stock backup; in-chat Doctor does not inspect them.

The slash-suggestion menu is a convenience. If an entry is missing, type the complete command manually; a menu entry alone does not prove routing works.

**ZIP path:** download the tagged release's **Source code (zip)**, open the extracted `grokrouter-…` folder, and double-click **Install GrokRouter.command**. A ZIP of a development branch contains that branch's candidate. If macOS asks whether to open the command, Control-click it and choose **Open**. Do not disable Gatekeeper.

## Install on Windows

Windows is a preview: CI builds x64 and Arm64 and smoke-runs this installer, but no native Windows live acceptance has run. You need Windows 10 or 11 (x64 or Arm64), the official Grok Bot app, and two free build tools. The installer never installs them for you; if one is missing it prints:

```powershell
winget install --exact --id OpenJS.NodeJS.LTS
winget install --exact --id Git.Git
```

Node.js must be 22.12 or newer. Install both, close the window, and open a new PowerShell. Then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/swcstudiospace/grokrouter/source-v0.1.0-beta.48/scripts/install-windows.ps1 | iex"
```

It downloads the tagged source, builds GrokRouter locally for your architecture, installs it per-user in `%LOCALAPPDATA%\Programs\GrokRouter`, adds a Start Menu shortcut, and opens it. It keeps one previous install as `GrokRouter.previous-<stamp>`. It needs no administrator rights, and the execution-policy bypass applies only to that one PowerShell process.

Until the `source-v0.1.0-beta.48` tag exists, build from a clone:

```powershell
git clone https://github.com/swcstudiospace/grokrouter.git; cd grokrouter; powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

**ZIP or clone path:** double-click **Install GrokRouter.cmd** in the extracted folder. Optional settings: `GROKROUTER_NO_OPEN=1` skips opening the app; `GROKROUTER_INSTALL_DIR` installs somewhere else. A GrokRouter installed by the Windows Setup program must be uninstalled from **Settings → Apps** first.

Then follow steps 3–5 of the Mac section. On Windows the buttons are **Check health**, **Repair**, and **Restore stock**.

## Unreviewed Grok Bot versions

Grok Bot updates itself. When it moves past every reviewed version, the installer refuses by default. Both installers have a checkbox, **Allow unreviewed Grok Bot version (experimental)**, which is **off by default**.

It applies only to a version strictly newer than every supported one (today, newer than 0.44.0). Older and in-between versions are always refused. A reviewed version never uses it.

With the checkbox on, the Bot computer accepts the live host only after structural verification:

- no GrokRouter, legacy, or other-router marker;
- every required anchor, including the three beta.47 patch seams, appears exactly once;
- a read-only copy of the patch passes `node --check`;
- the file size is within the band of the newest reviewed manifest whose anchors match.

The untouched host is backed up before patching. Doctor reports `HOSTTRUST=UNREVIEWED-ANCHOR-VERIFIED` and an `UNREVIEWED VERSION` line. There is no signed registry for unreviewed versions. If the new build moved any anchor, installation stops before changing anything and prints a compatibility report with `PATCHANCHORS=` and `PATCHDRYRUN=`.

**The risk:** structural checks cannot prove the backed-up host is genuine stock Grok code. That is why reviewed versions never use this path and why it is off by default. Use it only on a Bot computer you are willing to restore.

**To stop:** click **Restore Stock Grok Bot** (Windows: **Restore stock**). It returns the backed-up host and disables automatic repair. Reinstall without the checkbox once a reviewed release supports your version.

## Use it

Type these into a Bot's normal chat box. Both modes publish native slash entries for `/provider`, `/models`, `/model`, `/reasoning`, `/router`, and `/doctor`. In the host adapter the router handles every recognized command before model inference, so no model sees it; in delegation mode Grok runs `grokbot-router control` in the Bot computer and relays the receipt, and `/route` delegates the task itself.

| Command | What it does |
| --- | --- |
| `/provider` | Show this Bot's provider and model |
| `/provider codex`, `openrouter`, `anthropic`, `xai` | Switch this Bot to that provider |
| `/models` | Show the provider's model list and catalog freshness |
| `/models free` | List free OpenRouter models from the live catalog |
| `/models all [page]` | Page through every model the provider offers |
| `/models search <text>` | Search the list by vendor or model name |
| `/models refresh` | Re-read the provider's model list now |
| `/model <id>` or `/models <id>` | Switch this Bot to a specific model |
| `/model sonnet`, `opus`, `haiku`, `fable` | Newest Claude model in that family (Anthropic, or OpenRouter `anthropic/`) |
| `/model sol`, `terra`, `luna`, `astra` | Newest GPT model in that family (Codex, or OpenRouter `openai/`) |
| `/model grok` | Newest Grok model (xAI, or OpenRouter `x-ai/`) |
| `/model free` | OpenRouter's rotating `openrouter/free` router |
| A catalog `vendor/model` ID by itself | Switch an OpenRouter Bot to that model |
| `/reasoning` | Show this Bot's reasoning effort |
| `/reasoning minimal\|low\|medium\|high\|xhigh` | Change reasoning effort where the model supports it |
| `/router reset` | Start a fresh provider thread; the Grok transcript stays |
| `/router doctor` or `/doctor` | Report runtime, provider, credential health, catalog freshness, and recent failures |
| `/router help` | Show the exact supported controls |

In a channel, address a Bot directly, for example `@Research Bot /provider`. Each Bot owns its own provider, model, and reasoning state. Invalid or near-miss controls return help instead of reaching the model.

## New models

New models need no GrokRouter release. Each provider's list is discovered live:

| Provider | Source |
| --- | --- |
| OpenRouter | Public model catalog |
| xAI | Authenticated `/v1/models` on the metered API and the subscription proxy |
| Anthropic | The Claude Agent SDK's `supportedModels()` (no turn is started) |
| Codex | The pinned Codex CLI's `codex debug models`: account refresh first, then its bundled catalog |

Each list is cached for one hour per provider. Fallback order is live → cache → packaged list, and discovery never breaks a turn. The `/models` footer shows `Catalog: live|cached|bundled|packaged, updated …`. `/models refresh` forces a new read; `/router doctor` shows every provider's catalog freshness.

Family aliases resolve against the cached catalog to the newest model in that family. For example, once `anthropic/claude-sonnet-5.5` is in the OpenRouter catalog, `/model sonnet` picks it. `:batch` and `-pro` variants never match. If the cache has no match, a pinned alias applies; on OpenRouter `sonnet` → `anthropic/claude-sonnet-5.5`, `opus` → `anthropic/claude-opus-5.5`, `grok` → `x-ai/grok-4.7`.

You can paste any well-formed model ID. An ID that is not in the known list still switches, with a note that requests may fail until it exists. The installer's model fields accept any well-formed ID too (strict validation: no spaces or shell characters), with suggestions including `anthropic/claude-sonnet-5.5` and `anthropic/claude-opus-5.5`.

A Bot keeps its chosen model until you run `/model`. GrokRouter does not switch an existing Bot's default when a newer model appears.

## Update, restore, uninstall

**Update:** run the install command for the new tag, then click **Install Router** again. Installing beta.48 over an earlier GrokRouter authenticates the existing adapter by byte-exact reconstruction (the current build, upstream beta.45, beta.46, and beta.47, and earlier fork builds) before using the stock backup. Per-Bot state, threads, and audit history are preserved. A marker string alone is never enough.

**Repair:** **Repair Router** (Windows: **Repair**) reapplies the adapter only when the live host is a reviewed stock host or an exactly reconstructed supported router. It never replaces an unknown host with an older backup just because the backup exists.

**Restore:** **Restore Stock Grok Bot** (Windows: **Restore stock**) verifies the stock backup, restores it atomically, disables the repair watchdog, and restarts the host. The runtime and backups stay on the Bot computer.

The same controls exist inside the Bot computer:

```bash
grokbot-router status
grokbot-router doctor
grokbot-router disable     # keep the adapter, route new sessions to stock inference
grokbot-router enable
grokbot-router repair
grokbot-router uninstall   # restore the verified stock host
grokbot-router errors      # recent routed-turn failures
```

**Uninstall:** restore stock first, then delete the app: `~/Applications/GrokRouter.app` on Mac, or `%LOCALAPPDATA%\Programs\GrokRouter` and the **GrokRouter** Start Menu shortcut on Windows.

Use the GrokRouter desktop app for installation, health checks, repair, and restoration. Do not ask a Grok conversation to install or patch its own host.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `/provider` is missing from the slash menu | Type the complete command manually and press Return. The menu is not the test. If Doctor reports a skill conflict for `provider`, `models`, `model`, `reasoning`, `router`, or `doctor`, rename that user skill and reinstall. |
| Grok answers a router command conversationally, opens its terminal, or offers to install GrokRouter itself | The router did not intercept the command. Stop that attempt and use the desktop app: **Run Doctor**, then **Repair Router**. |
| Grok Bot is newer than the reviewed versions | Read [Unreviewed Grok Bot versions](#unreviewed-grok-bot-versions). Either wait for a reviewed release or opt in knowingly. |
| Grok Bot version refused and it is older than the newest reviewed version | That version is not supported and the opt-in does not apply. Update Grok Bot. |
| `install the official Grok Bot app in Applications first` | Put the official app at `/Applications/Grok Bot.app`, open it once, and retry. |
| Unknown host hash or wrong byte count | The installer leaves the live host untouched, even if an old backup exists. Click **Copy safe diagnostics** and open a support issue. A maintainer must review an exact host entry. |
| Unreviewed install stopped with `PATCHANCHORS=` or `PATCHDRYRUN=` | The new build moved source lines. Nothing was changed. Submit the safe diagnostics; the version needs a host probe ([docs/VERSION-TRACKING.md](docs/VERSION-TRACKING.md)). |
| Runtime version is correct but Doctor says `stock-or-unknown`, `no router marker`, or the adapter is not patched | Runtime files and the live adapter are separate. Run **Run Doctor**, then **Repair Router**, in the desktop app. Then quit and reopen Grok Bot and test in a new Bot. |
| Modified router with a valid stock backup | Automatic repair refuses it. Use **Restore Stock Grok Bot** if you intend to replace the live host, then install again. |
| No verified backup | Stop. Do not copy an arbitrary backup or force installation. Include the complete safe fingerprint in a support issue. |
| You previously installed OpenGrok or another router | Do not layer routers. Use that router's removal or a verified **Restore Stock Grok Bot** first. |
| GrokRouter asks for a Bot computer, or shows `Action needed` | In Grok Bot, select any Bot and click **Open computer**. Leave it open; the installer continues. |
| Installation stopped while downloading dependencies | Check the Bot computer's internet access, then click **Try installation again**. |
| Xcode Command Line Tools are required | Finish Apple's installation, then repeat the install command. |
| macOS will not open the command | Control-click **Install GrokRouter.command**, choose **Open**, confirm **Open**. Do not disable Gatekeeper. |
| Windows installer lists missing tools | Run the printed `winget` lines, open a new PowerShell, and run the command again. |
| Install command returns 404 | The beta.48 tag is not published yet. Use the from-clone command in the install section. |
| Codex is not signed in | Click **Start Codex Sign-in** and complete the device flow. |
| Anthropic is not signed in, or Doctor says the Claude Agent SDK is missing | Reinstall with **Anthropic** checked, then click **Start Anthropic Sign-in**. The installer verifies the SDK binary matches the Bot computer's platform and C library. |
| xAI says not signed in or sign-in expired | Click **Start xAI Sign-in** again. A 403 means that account's plan does not include agent access. |
| xAI keeps failing with `bad-request` | The message repeats xAI's words; a named field is dropped and remembered. Run `grokbot-router probe xai` in the Bot computer to see which request shapes your account accepts. |
| OpenRouter reports a credential problem | Paste the complete key beginning with `sk-or-v1-`, with no surrounding spaces. |
| `Model Router error [code]` in a Bot | The code names the cause and the message names the fix. `/router doctor` lists the three most recent failures; `grokbot-router errors` prints more. |
| A new model is missing from `/models` | Send `/models refresh`. You can also paste the ID; it switches with a note. |

For [installation support](https://github.com/swcstudiospace/grokrouter/issues/new?template=installation-failure.yml), include your GrokRouter version, Grok Bot version, platform, prior-router history, and the complete **Copy safe diagnostics** output. Keep `HOSTSHA1`, `HOSTSHA2`, `HOSTBYTES`, `ANCHORS`, `PATCHANCHORS`, `PATCHDRYRUN`, and `HOSTTRUST`. Never post an API key, sign-in code, private conversation, or Grok's host source.

## What verification means

For a reviewed version, GrokRouter requires an exact reviewed **SHA-256 and byte count**, then checks every source anchor and patch seam and syntax-checks the transformed file. Entries come from the bundled manifest or an Ed25519-signed compatibility registry. The fork signs registries with its own key (`compatibility/registry-public-key.pem`); upstream signatures are not trusted, and registry refresh downloads from this repository.

The selected model can request only the outer tools Grok supplies for that turn. Grok still applies its permissions and performs those actions. Codex Sol and OpenRouter Claude passed real Shell, Read, Screenshot, and completed-child tests on 0.30.0 and 0.36.0 in beta.47. Other models, providers, and versions do not inherit those results. Exact receipts and limits are in [TEST-MATRIX.md](docs/TEST-MATRIX.md).

Provider credentials stay out of repository files, Bot state, and diagnostic logs. Routed conversation content goes to the provider you choose. Read [SECURITY.md](SECURITY.md) and [HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the data boundary.

## For developers and maintainers

```bash
npm ci --prefix runtime --ignore-scripts --no-audit --no-fund
npm test
npm run build:macos
npm run test:windows
npm run build:windows -- x64
npm run build:windows -- arm64
```

`npm test` covers the provider runtime, patch/restore engine, payload install, both installers' contracts, and release consistency. Local Mac builds are ad-hoc signed. Windows builds need Git Bash and Node.js 22.12+, plus Inno Setup 6 for a native Setup executable; they are unsigned unless an Authenticode certificate is supplied.

**Reviewing a new Grok Bot version:** run `scripts/host-probe.py` in a Bot computer on that version (or let the self-hosted `grokbot-box` runner's auto-probe do it). Paste the result into the **Ingest host probe** workflow or run `scripts/new-manifest-from-probe.py`. That writes the manifest, adds the version to `compatibility/supported-apps.json`, writes an unsigned `compatibility/<version>-hosts.json`, and updates the Swift and Windows installer version lists. A maintainer then signs locally:

```bash
node scripts/sign-host-registry.mjs compatibility/<version>-hosts.json
```

The private key lives at `~/.config/grokrouter/release/host-registry-private.pem` (override with `GROKROUTER_HOST_REGISTRY_PRIVATE_KEY`) and never enters the repository or CI. The live fresh-Bot gate must pass before merge. The full pipeline is in [VERSION-TRACKING.md](docs/VERSION-TRACKING.md).

**Releasing:** both install scripts and both README commands must pin the same tag (`node scripts/verify-release.mjs`). The **Tag source release** workflow creates the tag only after live acceptance is recorded. See [RELEASE.md](docs/RELEASE.md).

- [How it works](docs/HOW-IT-WORKS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Fresh-Bot acceptance gate](docs/FRESH-BOT-ACCEPTANCE.md)
- [Verification matrix](docs/TEST-MATRIX.md)
- [Version tracking](docs/VERSION-TRACKING.md)
- [Release procedure](docs/RELEASE.md)
- [Maintenance status](docs/MAINTENANCE-STATUS.md)
- [Release notes](RELEASE_NOTES.md)
- [Coding-agent instructions](AGENTS.md)

## Security

Read [SECURITY.md](SECURITY.md) before distributing access. GrokRouter contains its own adapter and provider runtime. It does not distribute Grok Bot's proprietary host source or replace the official desktop app. Personal, non-commercial source builds are allowed; redistribution is not. See [the license](LICENSE.md).
