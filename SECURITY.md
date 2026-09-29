# Security and trust boundary

This is an unofficial compatibility adapter. It modifies code inside a Grok Bot cloud computer and therefore deserves the same caution as any developer tool that can execute code and use a computer on your behalf.

The official source is <https://github.com/swcstudiospace/grokrouter>, the maintained fork of the no-longer-maintained `promptadvisers/grokrouter`. Install only from the maintained repository; older copies carry an earlier router and the upstream registry signing key. The supported installer shells are built locally from that source. GrokRouter does not ask users to bypass an unknown-developer or signature warning for a downloaded binary.

## Source installers

Both pinned commands download the source archive of one immutable `source-v<version>` tag from GitHub over HTTPS, build the desktop app on the user's own computer, and need no administrator rights.

- macOS: `scripts/install-macos.sh` requires Apple's Command Line Tools, installs `GrokRouter.app` into `~/Applications`, verifies its code signature, and moves a previous copy to the Trash.
- Windows 10/11 (x64 or Arm64): `scripts/install-windows.ps1` requires Node.js 22.12 or newer and Git for Windows. It never installs them itself; it prints the `winget` commands and stops. It installs per user into `%LOCALAPPDATA%\Programs\GrokRouter`, adds a per-user Start menu shortcut, and keeps exactly one previous copy beside it as `GrokRouter.previous-<timestamp>`. `-ExecutionPolicy Bypass` in the pinned command applies only to that one PowerShell process; the installer does not change the execution policy. The locally built executable is not downloaded, so Windows has no download warning to dismiss.

## What the installer can access

The macOS installer validates `/Applications/Grok Bot.app`. The Windows installer locates the official app, requires a Grok Bot version listed in `compatibility/supported-apps.json`, and requires a valid Authenticode signature before continuing. Each restarts Grok Bot with an Electron diagnostic port bound only to `127.0.0.1` and uses the local connection to operate the already-visible noVNC Bot computer. The Mac app does not request operating-system Accessibility, Screen Recording, or Full Disk Access permissions; the Windows renderer runs with context isolation, no Node integration, and the Electron sandbox enabled.

Inside the Bot computer, the bootstrap can write under `/home/box/sand-data/grokbot-router`, back up and atomically replace `/home/box/sand-host/host-main.cjs`, run `npm ci`, restart the Grok host process, and invoke the installed Codex login flow.

## Credentials

- Codex authentication is handled by the pinned Codex CLI/SDK device flow inside the Bot computer.
- An OpenRouter key entered in GrokRouter is passed over the loopback-only DevTools session directly to `window.desktop.secrets.upsert` and Grok Bot's protected Secrets store. The installer clears its field after the protected handoff.
- The runtime reads the key from the environment or Grok Bot Secrets at request time.
- Credentials are never intentionally printed, included in provider state, included in release artifacts, or sent to audit logs.
- `grokbot-router doctor` reports presence/status only and redacts account email output.

## Network destinations

Depending on selected providers, the Bot computer connects to npm during installation, OpenAI/Codex endpoints for Codex operation, and `openrouter.ai` for OpenRouter completions. The routed model receives the Grok conversation and any attachments/tool results needed for the turn. Selecting a third-party OpenRouter model means that provider may also process the request under OpenRouter's routing and privacy terms.

## Integrity and recovery

The release archive has an external SHA-256 file. Its bootstrap validates an internal `SHA256SUMS` manifest before executing. Reviewed host fingerprints ship in `compatibility/*-hosts.json`, signed with the maintained fork's Ed25519 key in `compatibility/registry-public-key.pem`; registries signed with any other key are rejected. The host patch requires a known stock hash plus three exact source anchors. It saves verified stock and timestamped pre-change backups, syntax-checks the generated host, and activates it atomically. Restore also syntax-checks the verified stock backup before atomic replacement.

The installer refuses unknown Grok Bot builds by default. The one exception is the explicit, default-off installer option **Allow unreviewed Grok Bot version (experimental)**, which applies only to a desktop version newer than every reviewed version. In that mode the host must contain no router marker, every required anchor exactly once, pass a read-only patch and `node --check`, and fall inside the reviewed byte-count band; diagnostics then report `HOSTTRUST=UNREVIEWED-ANCHOR-VERIFIED` rather than an exact-hash match. Older versions and versions between reviewed releases are always refused. `--allow-unknown-host` exists only for synthetic tests and must never appear in distributed commands.

## Reporting

Report suspected credential exposure, unsafe patch behavior, or unintended tool access through a [private security advisory](https://github.com/swcstudiospace/grokrouter/security/advisories/new) on the maintained repository. Do not put secrets or private Grok transcripts in a public issue. Rotate any credential that may have been exposed and restore stock Grok Bot before further diagnosis.
