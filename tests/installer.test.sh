#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash -n \
  "$PROJECT_ROOT/remote/install.sh" \
  "$PROJECT_ROOT/remote/install-delegation.sh" \
  "$PROJECT_ROOT/scripts/install-bot.sh" \
  "$PROJECT_ROOT/scripts/register-commands.sh" \
  "$PROJECT_ROOT/remote/grokbot-router" \
  "$PROJECT_ROOT/remote/grokbot-router-watchdog" \
  "$PROJECT_ROOT/remote/host-registry" \
  "$PROJECT_ROOT/scripts/build-payload.sh" \
  "$PROJECT_ROOT/scripts/build-macos-app.sh" \
  "$PROJECT_ROOT/scripts/install-macos.sh" \
  "$PROJECT_ROOT/Install GrokRouter.command"
python3 -m py_compile "$PROJECT_ROOT/patch/router_patch.py"
node --check "$PROJECT_ROOT/runtime/run-provider.mjs"
node --check "$PROJECT_ROOT/runtime/delegate.mjs"
node --check "$PROJECT_ROOT/scripts/register-native-commands.mjs"
node --check "$PROJECT_ROOT/runtime/serve.mjs"
node --check "$PROJECT_ROOT/runtime/tailnet.mjs"
node --check "$PROJECT_ROOT/runtime/openrouter-catalog.mjs"
node --check "$PROJECT_ROOT/runtime/xai-oauth.mjs"
node --check "$PROJECT_ROOT/runtime/model-catalog.mjs"
node --check "$PROJECT_ROOT/remote/verify-host-registry.mjs"
node --check "$PROJECT_ROOT/scripts/sign-host-registry.mjs"
node "$PROJECT_ROOT/remote/verify-host-registry.mjs" \
  "$PROJECT_ROOT/compatibility/0.30.0-hosts.json" \
  "$PROJECT_ROOT/compatibility/0.30.0-hosts.json.sig" \
  "$PROJECT_ROOT/compatibility/registry-public-key.pem" \
  >/dev/null
TAMPERED_REGISTRY="$(mktemp -t grokrouter-tampered-registry.XXXXXX)"
cp "$PROJECT_ROOT/compatibility/0.30.0-hosts.json" "$TAMPERED_REGISTRY"
printf ' ' >> "$TAMPERED_REGISTRY"
if node "$PROJECT_ROOT/remote/verify-host-registry.mjs" \
  "$TAMPERED_REGISTRY" \
  "$PROJECT_ROOT/compatibility/0.30.0-hosts.json.sig" \
  "$PROJECT_ROOT/compatibility/registry-public-key.pem" \
  >/dev/null 2>&1; then
  echo "Tampered compatibility registry must be rejected" >&2
  exit 1
fi
rm -f "$TAMPERED_REGISTRY"

STRUCTURED_FAILURE="$(ROUTER_INSTALL_ATTEMPT=TEST1234 bash "$PROJECT_ROOT/remote/install.sh" --not-a-real-option 2>&1 || true)"
grep -q 'GROKROUTER_TEST1234_INSTALL_FAILED_OPTIONS_UNKNOWN_OPTION' <<<"$STRUCTURED_FAILURE"
PROVIDER_FAILURE="$(ROUTER_INSTALL_ATTEMPT=PROV1 bash "$PROJECT_ROOT/remote/install.sh" --provider gemini --no-restart 2>&1 || true)"
grep -q 'GROKROUTER_PROV1_INSTALL_FAILED_OPTIONS_INVALID_PROVIDER' <<<"$PROVIDER_FAILURE"
PROVIDERS_FAILURE="$(ROUTER_INSTALL_ATTEMPT=PROV2 bash "$PROJECT_ROOT/remote/install.sh" --providers codex,gemini --no-restart 2>&1 || true)"
grep -q 'GROKROUTER_PROV2_INSTALL_FAILED_OPTIONS_INVALID_PROVIDERS' <<<"$PROVIDERS_FAILURE"
XAI_MODEL_FAILURE="$(ROUTER_INSTALL_ATTEMPT=PROV3 bash "$PROJECT_ROOT/remote/install.sh" --xai-model 'grok 4' --no-restart 2>&1 || true)"
grep -q 'GROKROUTER_PROV3_INSTALL_FAILED_OPTIONS_INVALID_XAI_MODEL' <<<"$XAI_MODEL_FAILURE"
# Installers type model IDs into the Bot terminal: shell metacharacters must
# stop install.sh before anything runs.
for rejected_model in "--codex-model a;b INVALID_CODEX_MODEL" "--openrouter-model vendor/model\$(id) INVALID_OPENROUTER_MODEL" "--openrouter-model no-slash INVALID_OPENROUTER_MODEL" "--anthropic-model claude|sh INVALID_ANTHROPIC_MODEL"; do
  read -r model_option model_value model_code <<<"$rejected_model"
  MODEL_FAILURE="$(ROUTER_INSTALL_ATTEMPT=MODEL1 bash "$PROJECT_ROOT/remote/install.sh" "$model_option" "$model_value" --no-restart 2>&1 || true)"
  grep -q "GROKROUTER_MODEL1_INSTALL_FAILED_OPTIONS_$model_code" <<<"$MODEL_FAILURE"
done
UNREVIEWED_OPTION_FAILURE="$(ROUTER_INSTALL_ATTEMPT=UNREV0 bash "$PROJECT_ROOT/remote/install.sh" --allow-unreviewed-version --no-restart 2>&1 || true)"
grep -q 'GROKROUTER_UNREV0_INSTALL_FAILED_OPTIONS_INVALID_UNREVIEWED_VERSION' <<<"$UNREVIEWED_OPTION_FAILURE"
grep -q 'auth xai' "$PROJECT_ROOT/remote/grokbot-router"
grep -q 'resolve_claude_cli' "$PROJECT_ROOT/remote/grokbot-router"
grep -q 'glibcVersionRuntime' "$PROJECT_ROOT/remote/grokbot-router"
grep -q 'glibcVersionRuntime' "$PROJECT_ROOT/remote/install.sh"
grep -q -- '--recent-errors' "$PROJECT_ROOT/remote/grokbot-router"
grep -q -- '--xai-probe' "$PROJECT_ROOT/remote/grokbot-router"
grep -q 'Model Router error \[' "$PROJECT_ROOT/patch/router_patch.py"
grep -q 'xai-\[a-z0-9_-\]' "$PROJECT_ROOT/patch/router_patch.py"
grep -q 'auth anthropic' "$PROJECT_ROOT/remote/grokbot-router"
grep -q '"@anthropic-ai/claude-agent-sdk": "0.3.285"' "$PROJECT_ROOT/runtime/package.json"
grep -q 'await import("@anthropic-ai/claude-agent-sdk")' "$PROJECT_ROOT/runtime/run-provider.mjs"
grep -q 'Start Anthropic Sign-in' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'Start xAI Sign-in' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q -- '--anthropic-model' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q -- '--xai-model' "$PROJECT_ROOT/installer-windows/main.cjs"
PREFLIGHT_FAILURE="$(PATH=/usr/bin:/bin:/sbin ROUTER_INSTALL_ATTEMPT=PREF123 bash "$PROJECT_ROOT/remote/install.sh" --no-restart 2>&1 || true)"
grep -q 'GROKROUTER_PREF123_PHASE_PREFLIGHT' <<<"$PREFLIGHT_FAILURE"
grep -q 'GROKROUTER_PREF123_INSTALL_FAILED_PREFLIGHT_MISSING_COMMAND' <<<"$PREFLIGHT_FAILURE"
/usr/bin/swiftc \
  -swift-version 5 \
  -target arm64-apple-macosx12.0 \
  -typecheck \
  -framework AppKit \
  -framework Vision \
  -framework CryptoKit \
  "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"

grep -q 'typeRemoteCommandsResilient' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'let timeout = DispatchWorkItem' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'task.cancel(with: .goingAway' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'local diagnostic connection stopped responding' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
[[ "$(grep -c 'Target.detachFromTarget' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift")" -eq 2 ]]
grep -q 'Reuse an already open computer' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'let transportVNC = try await typeRemoteCommandsResilient' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'ensureTerminal' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'resetRemotePrompt' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'typeRemoteCommand("clear"' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'key: "c", code: "KeyC"' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'Opening Terminal from the Bot desktop dock' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'clickRemoteDesktop' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q "import('./app/ui.js')" "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'UI.rfb._handleMouseButton' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'UI.rfb.sendKey' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'emitted % 8 === 0' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'setTimeout(resolve, 4)' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'did not accept noVNC text input' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
! grep -q 'Input.insertText' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'did not accept a noVNC pointer event' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'remoteX: 700, remoteY: 768' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'waitForTerminalPrompt(client, vncSession: vncSession, attempts: 24)' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'request.recognitionLevel = .accurate' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
[[ "$(grep -c 'waitForTerminalPrompt(client, vncSession: vncSession, attempts: 24)' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift")" -eq 2 ]]
grep -q "getElementById('noVNC_container')" "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q "getElementById('noVNC_canvas')" "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'framebufferWidth = Number(canvas?.width) || 1280' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'framebufferHeight = Number(canvas?.height) || 800' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'return JSON.stringify' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq 'x: rect.left + (\(remoteX) / framebufferWidth) * rect.width' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq 'y: rect.top + (\(remoteY) / framebufferHeight) * rect.height' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'payload.b64' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'only completion authority' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
! grep -q 'GROKBOT_ROUTER_COMMAND_ACCEPTED' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'installPayload.*base64EncodedString' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'installAttempt: installAttempt' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'let failurePayload = Data' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq 'printf %s \(failurePayload) | base64 -d; echo $code' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
# The typed command must never contain a plain-text sentinel: OCR reads the
# echoed command line and would report a failure before install.sh finishes.
! grep -q 'echo GROKROUTER_\\(installAttempt)_INSTALL_FAILED' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'INSTALLFAILED' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'Copy safe diagnostics' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'complete host fingerprint is included' "$PROJECT_ROOT/remote/install.sh"
grep -q 'exact signed compatibility list' "$PROJECT_ROOT/remote/install.sh"
grep -q 'HOSTSHA1=' "$PROJECT_ROOT/patch/router_patch.py"
grep -q 'HOSTTRUST=' "$PROJECT_ROOT/patch/router_patch.py"
grep -q '"anchorVerifiedHosts"' "$PROJECT_ROOT/patch/manifests/0.30.0.json"
grep -q 'makeInstallAttemptID' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'ocrSafeAlphabet = Array("ACEFHJKMNPRUVWXY349")' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
! grep -q 'UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8)' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'remainingTicks = ticksPerWindow' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'INSTALLFA"' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q '"HOSTTRUST"' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'signed-compatibility-registry-refreshed' "$PROJECT_ROOT/remote/grokbot-router-watchdog"
grep -q 'Try installation again' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'Open support issue' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'installation-failure.yml' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'Action needed' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'confirmationSentinel: "Welcome to Codex"' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'confirmationSentinel: "GROKBOT_ROUTER_DOCTOR_DONE"' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'confirmationSentinel: "GROKBOT_ROUTER_REPAIR_OK"' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'native-workflow-registration' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'updateNativeWorkflows' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'GROKROUTER_NATIVE_COMMAND' "$PROJECT_ROOT/installer/native-workflow-registration.js"
grep -q 'app.workflows.install' "$PROJECT_ROOT/installer/native-workflow-registration.js"
grep -q 'app.workflows.update' "$PROJECT_ROOT/installer/native-workflow-registration.js"
grep -q 'app.workflows.remove' "$PROJECT_ROOT/installer/native-workflow-registration.js"
grep -q 'agent.id === selectedAgentId' "$PROJECT_ROOT/installer/native-workflow-registration.js"
grep -q 'waitForSelectedAgentId' "$PROJECT_ROOT/installer/native-workflow-registration.js"
grep -q 'selection can be superseded' "$PROJECT_ROOT/installer/native-workflow-registration.js"
grep -q 'workflowReadyTimeoutMs = 45_000' "$PROJECT_ROOT/installer/native-workflow-registration.js"
grep -q 'remove duplicate' "$PROJECT_ROOT/installer/native-workflow-registration.js"
grep -q 'withRetries' "$PROJECT_ROOT/installer/native-workflow-registration.js"
grep -q 'stats.unchanged' "$PROJECT_ROOT/installer/native-workflow-registration.js"
if grep -q 'Promise.all(agents' "$PROJECT_ROOT/installer/native-workflow-registration.js"; then
  echo "Native workflows must be reconciled once through Grok Bot's global library" >&2
  exit 1
fi
grep -q 'private let repairButton' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'Bring your own model.' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
! grep -q 'Bring your own brain.' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
expected_versions="$(grep -h '"grokBotVersion"' "$PROJECT_ROOT"/patch/manifests/*.json | sed 's/.*"grokBotVersion": *"\([^"]*\)".*/\1/' | sort -u)"
expected_eyebrow="GROK BOT $(printf '%s\n' "$expected_versions" | awk '{if (NR>1) printf " · "; printf "%s", $0}')"
expected_swift_list="$(printf '%s\n' "$expected_versions" | awk '{printf "%s\"%s\"", (NR>1 ? ", " : "["), $0} END {print "]"}')"
grep -Fq "labelWithString: \"$expected_eyebrow\"" "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq "private let supportedGrokVersions = $expected_swift_list" "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'supportedGrokVersions.contains(version)' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq 'private let codexModelField = NSComboBox()' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq 'field.isEditable = true' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
! grep -Fq 'Custom model ID' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq '#"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$"#' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq '#"^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$"#' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq 'models.first(where: { !Self.isValidModelID($0.id, provider: $0.provider) })' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq '"Allow unreviewed Grok Bot version (experimental)"' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq '\(detectedGrokVersion)\(unreviewedGrokVersion ? " --allow-unreviewed-version" : "") --provider' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq 'Grok Bot mode: \(grokMode)' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq '"SUPPORTEDVERSION", "UNREVIEWED"]' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
! grep -q 'promptadvisers' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q '"anchorVerifiedHosts"' "$PROJECT_ROOT/patch/manifests/0.44.0.json"
! grep -q 'PRIVATE BETA' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq 'contentRect: NSRect(x: 0, y: 0, width: 780, height: 884)' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -Fq 'NSStackView(views: [hero, modelCard, installCard, statusCard, activityLabel, scroll])' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'InstallerCardView' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'window.title = "GrokRouter"' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
[[ "$(grep -c '<string>GrokRouter</string>' "$PROJECT_ROOT/installer/Info.plist")" -eq 2 ]]
grep -Fq 'APP_ROOT="$BUILD_ROOT/GrokRouter.app"' "$PROJECT_ROOT/scripts/build-macos-app.sh"
grep -q 'grokrouter-native-skills' "$PROJECT_ROOT/scripts/build-macos-app.sh"
grep -Fq 'ZIP_PATH="$BUILD_ROOT/grokrouter-${VERSION}-macos.zip"' "$PROJECT_ROOT/scripts/build-macos-app.sh"
grep -q 'ROUTER_BUILD_APP_ONLY' "$PROJECT_ROOT/scripts/build-macos-app.sh"
! grep -q 'DMG_PATH\|hdiutil create' "$PROJECT_ROOT/scripts/build-macos-app.sh"
grep -q 'GROKROUTER_APPLICATIONS_DIR' "$PROJECT_ROOT/scripts/install-macos.sh"
grep -q 'GROKROUTER_NO_OPEN' "$PROJECT_ROOT/scripts/install-macos.sh"
grep -q 'xcode-select --install' "$PROJECT_ROOT/scripts/install-macos.sh"
(cd "$PROJECT_ROOT" && node scripts/verify-release.mjs >/dev/null)
grep -Fq 'id: install_source' "$PROJECT_ROOT/.github/ISSUE_TEMPLATE/installation-failure.yml"
grep -Fq 'id: literal_provider_result' "$PROJECT_ROOT/.github/ISSUE_TEMPLATE/installation-failure.yml"
grep -Fq 'id: host_adapter_result' "$PROJECT_ROOT/.github/ISSUE_TEMPLATE/installation-failure.yml"
grep -q 'codesign --verify --deep --strict' "$PROJECT_ROOT/scripts/install-macos.sh"
! grep -q 'sudo' "$PROJECT_ROOT/scripts/install-macos.sh"
grep -q 'CFBundleIconFile' "$PROJECT_ROOT/installer/Info.plist"
[[ -f "$PROJECT_ROOT/installer/Assets/AppIcon.icns" ]]
grep -q '"format": "jpeg"' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q '"quality": 55' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'isValidOpenRouterKey' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'previousSelection' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'relaunchGrokNormallyIfNeeded' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'Closing the temporary diagnostic port' "$PROJECT_ROOT/installer/GrokBotRouterInstaller.swift"
grep -q 'completion marker before the host restart' "$PROJECT_ROOT/remote/install.sh"
grep -q 'GROKROUTER_%s_PHASE_%s' "$PROJECT_ROOT/remote/install.sh"
grep -q 'GROKROUTER_%s_INSTALL_FAILED_%s_%s' "$PROJECT_ROOT/remote/install.sh"
grep -q -- '--fetch-retries=3' "$PROJECT_ROOT/remote/install.sh"
grep -q -- '--fetch-timeout=30000' "$PROJECT_ROOT/remote/install.sh"
grep -q 'Reusing the already verified pinned Codex and Claude Agent SDK runtime' "$PROJECT_ROOT/remote/install.sh"
grep -q 'OpenRouter/xAI-only setup needs no dependency download' "$PROJECT_ROOT/remote/install.sh"
grep -q 'await import("@openai/codex-sdk")' "$PROJECT_ROOT/runtime/run-provider.mjs"
grep -q '"X-Title": "GrokRouter"' "$PROJECT_ROOT/runtime/run-provider.mjs"
! grep -q 'Prompt Advisers\|promptadvisers.com' "$PROJECT_ROOT/runtime/run-provider.mjs"
grep -q '<string>io.grokrouter.installer</string>' "$PROJECT_ROOT/installer/Info.plist"
grep -q 'Copyright 2026 Mark Kashef' "$PROJECT_ROOT/LICENSE.md"
! grep -q 'Prompt Advisers' "$PROJECT_ROOT/LICENSE.md" "$PROJECT_ROOT/runtime/package.json" "$PROJECT_ROOT/runtime/package-lock.json" "$PROJECT_ROOT/installer-windows/package.json" "$PROJECT_ROOT/scripts/build-windows-setup.ps1" "$PROJECT_ROOT"/skills/*/SKILL.md
[[ -f "$PROJECT_ROOT/.github/ISSUE_TEMPLATE/installation-failure.yml" ]]
grep -q 'Emit the restore sentinel before the delayed host restart' "$PROJECT_ROOT/remote/grokbot-router"
grep -q 'sleep 3; pkill -f' "$PROJECT_ROOT/remote/grokbot-router"
grep -q 'known-stock-host-repaired' "$PROJECT_ROOT/remote/grokbot-router-watchdog"
grep -q '"autoRepair": True' "$PROJECT_ROOT/remote/install.sh"
grep -q '/home/box/sand-data/grokbot-router-backup/host-main.cjs.stock' "$PROJECT_ROOT/remote/install.sh"
grep -q '/usr/local/bin/grokbot-router' "$PROJECT_ROOT/remote/install.sh"
grep -q 'sudo -n ln -sfn' "$PROJECT_ROOT/remote/install.sh"
grep -q '"@openai/codex-sdk": "0.151.0"' "$PROJECT_ROOT/runtime/package.json"

ARCHIVE="$(bash "$PROJECT_ROOT/scripts/build-payload.sh")"
[[ -f "$ARCHIVE" ]]
[[ -f "$ARCHIVE.sha256" ]]
shasum -a 256 -c "$ARCHIVE.sha256" >/dev/null

TEMPORARY="$(mktemp -d -t grokbot-router-test.XXXXXX)"
cleanup() {
  if [[ -f "$TEMPORARY/grokbot-router-chat.pid" ]]; then
    kill "$(cat "$TEMPORARY/grokbot-router-chat.pid")" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMPORARY"
}
trap cleanup EXIT
tar -xzf "$ARCHIVE" -C "$TEMPORARY"
PAYLOAD="$TEMPORARY/grokbot-router-payload"
(cd "$PAYLOAD" && shasum -a 256 -c SHA256SUMS >/dev/null)
[[ -f "$PAYLOAD/compatibility/0.30.0-hosts.json" ]]
[[ -f "$PAYLOAD/compatibility/0.30.0-hosts.json.sig" ]]
[[ -f "$PAYLOAD/compatibility/registry-public-key.pem" ]]
[[ -x "$PAYLOAD/remote/host-registry" ]]
[[ -x "$PAYLOAD/remote/verify-host-registry.mjs" ]]
[[ "$(cat "$PAYLOAD/VERSION")" == "$(node -p "require('$PROJECT_ROOT/package.json').version")" ]]
PAYLOAD_VERSION="$(cat "$PAYLOAD/VERSION")"
grep -Fq "const ROUTER_VERSION = \"$PAYLOAD_VERSION\";" "$PAYLOAD/runtime/run-provider.mjs"
grep -Fq "ROUTER_VERSION=\"$PAYLOAD_VERSION\"" "$PAYLOAD/remote/install.sh"
grep -Fq "version: \"$PAYLOAD_VERSION\"" "$PAYLOAD/patch/router_patch.py"
for skill_name in provider models model reasoning router doctor; do
  [[ -f "$PAYLOAD/skills/$skill_name/SKILL.md" ]]
  grep -q '^user-invocable: true$' "$PAYLOAD/skills/$skill_name/SKILL.md"
  grep -q '^disable-model-invocation: true$' "$PAYLOAD/skills/$skill_name/SKILL.md"
  grep -q "^GROKROUTER_NATIVE_CONTROL: $(printf '%s' "$skill_name" | tr '[:lower:]' '[:upper:]')$" "$PAYLOAD/skills/$skill_name/SKILL.md"
done
# /route is the delegation entry point: Grok may invoke it itself for tasks
# that belong to the delegated model, so it is the only model-invocable command.
[[ -f "$PAYLOAD/skills/route/SKILL.md" ]]
grep -q '^user-invocable: true$' "$PAYLOAD/skills/route/SKILL.md"
grep -q '^disable-model-invocation: false$' "$PAYLOAD/skills/route/SKILL.md"
grep -q '^GROKROUTER_NATIVE_CONTROL: ROUTE$' "$PAYLOAD/skills/route/SKILL.md"
grep -q 'grokbot-router run --task-file' "$PAYLOAD/skills/route/SKILL.md"
for skill_name in provider models model reasoning router doctor; do
  grep -q "grokbot-router control \"/$skill_name" "$PAYLOAD/skills/$skill_name/SKILL.md"
done
[[ -x "$PAYLOAD/remote/install-delegation.sh" ]]
[[ -f "$PAYLOAD/runtime/delegate.mjs" ]]
[[ -f "$PAYLOAD/runtime/serve.mjs" ]]
[[ -f "$PAYLOAD/runtime/chat.html" ]]
[[ -f "$PAYLOAD/runtime/tailnet.mjs" ]]
grep -Fq "ROUTER_VERSION=\"$PAYLOAD_VERSION\"" "$PAYLOAD/remote/install-delegation.sh"
DELEGATION_MINIMUM="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["delegation"]["minimumVersion"])' "$PROJECT_ROOT/compatibility/supported-apps.json")"
grep -Fq "MINIMUM_GROK_VERSION=\"$DELEGATION_MINIMUM\"" "$PAYLOAD/remote/install-delegation.sh"

HOST_FIXTURE="$PROJECT_ROOT/tests/fixtures/host-main.cjs"
TEST_HOST="$TEMPORARY/host-main.cjs"
TEST_BACKUP="$TEMPORARY/host-main.cjs.stock"
TEST_RUNTIME="$TEMPORARY/runtime"
TEST_BIN="$TEMPORARY/bin"
TEST_GROK_SKILLS="$TEMPORARY/grok-skills"

# A syntactically compatible unknown host must remain untouched even when
# an independently trusted backup already exists. Exercise the real installer.
ANCHOR_RUNTIME="$TEMPORARY/anchor-runtime"
ANCHOR_HOST="$TEMPORARY/anchor-host-main.cjs"
ANCHOR_BACKUP="$TEMPORARY/anchor-host-main.cjs.stock"
STRICT_MANIFEST="$TEMPORARY/strict-manifest.json"
python3 - "$PAYLOAD/patch/manifests/0.30.0.json" "$STRICT_MANIFEST" "$HOST_FIXTURE" <<'PYS'
import hashlib,json,sys
manifest = json.load(open(sys.argv[1]))
stock = open(sys.argv[3], "rb").read()
manifest["stockHosts"] = [{"sha256": hashlib.sha256(stock).hexdigest(), "bytes": len(stock)}]
json.dump(manifest, open(sys.argv[2], "w"))
PYS
cp "$HOST_FIXTURE" "$ANCHOR_BACKUP"
cp "$HOST_FIXTURE" "$ANCHOR_HOST"
printf '\n// unreviewed host replacement\n' >> "$ANCHOR_HOST"
cp "$ANCHOR_HOST" "$TEMPORARY/expected-rejected-host"
mkdir -p "$ANCHOR_RUNTIME"
STRICT_FAILURE="$(ROUTER_PATCH_HOST="$ANCHOR_HOST" \
ROUTER_PATCH_BACKUP="$ANCHOR_BACKUP" \
ROUTER_PATCH_MANIFEST="$STRICT_MANIFEST" \
ROUTER_BIN_DIR="$TEMPORARY/anchor-bin" \
ROUTER_GROK_SKILLS_ROOT="$TEMPORARY/anchor-grok-skills" \
ROUTER_INSTALL_ATTEMPT=STRICT9 \
bash "$PAYLOAD/remote/install.sh" \
  --install-root "$ANCHOR_RUNTIME" \
  --providers openrouter \
  --no-restart 2>&1 || true)"
grep -q 'GROKROUTER_STRICT9_INSTALL_FAILED_APPLY_ADAPTER_NEW_STOCK_HOST' <<<"$STRICT_FAILURE"
grep -q 'HOSTTRUST=NONE' <<<"$STRICT_FAILURE"
grep -q 'PATCHDRYRUN=PASS' <<<"$STRICT_FAILURE"
cmp "$TEMPORARY/expected-rejected-host" "$ANCHOR_HOST"
cmp "$HOST_FIXTURE" "$ANCHOR_BACKUP"

# The unreviewed opt-in never applies to a reviewed, older, or in-between
# version; those keep the exact gates.
for not_newer in 0.44.0 0.40.0 0.29.0; do
  NOT_NEWER_FAILURE="$(ROUTER_PATCH_HOST="$ANCHOR_HOST" \
  ROUTER_PATCH_BACKUP="$ANCHOR_BACKUP" \
  ROUTER_INSTALL_ATTEMPT=UNREV2 \
  bash "$PAYLOAD/remote/install.sh" \
    --install-root "$TEMPORARY/not-newer-runtime" \
    --grok-version "$not_newer" \
    --allow-unreviewed-version \
    --providers openrouter \
    --no-restart 2>&1 || true)"
  grep -q 'GROKROUTER_UNREV2_INSTALL_FAILED_VALIDATE_PAYLOAD_UNREVIEWED_VERSION_NOT_NEWER' <<<"$NOT_NEWER_FAILURE"
  [[ ! -e "$TEMPORARY/not-newer-runtime" ]]
done
cmp "$TEMPORARY/expected-rejected-host" "$ANCHOR_HOST"

# An opted-in unreviewed newer version installs by structural verification
# with its reviewed template; the registry tool, Doctor, and Restore Stock all
# keep honoring that recorded mode, and restore returns the exact stock bytes.
UNREVIEWED_RUNTIME="$TEMPORARY/unreviewed-runtime"
UNREVIEWED_HOST="$TEMPORARY/unreviewed-host-main.cjs"
UNREVIEWED_BACKUP="$TEMPORARY/unreviewed-backup/host-main.cjs.stock"
UNREVIEWED_MANIFEST="$TEMPORARY/unreviewed-template.json"
python3 - "$PAYLOAD/patch/manifests/0.36.0.json" "$UNREVIEWED_MANIFEST" <<'PYU'
import json,sys
manifest = json.load(open(sys.argv[1]))
# Fit the small fixture host inside the structural size band.
manifest["anchorVerifiedHosts"].update({"minBytes": 100, "maxBytes": 100000})
json.dump(manifest, open(sys.argv[2], "w"))
PYU
cp "$HOST_FIXTURE" "$UNREVIEWED_HOST"
printf '\n// unreviewed newer Grok Bot build\n' >> "$UNREVIEWED_HOST"
cp "$UNREVIEWED_HOST" "$TEMPORARY/expected-unreviewed-host"
mkdir -p "$UNREVIEWED_RUNTIME"
run_unreviewed() {
  ROUTER_PATCH_HOST="$UNREVIEWED_HOST" \
  ROUTER_PATCH_BACKUP="$UNREVIEWED_BACKUP" \
  ROUTER_PATCH_MANIFEST="$UNREVIEWED_MANIFEST" \
  ROUTER_HOST_REGISTRY_ROOT="$TEMPORARY/unreviewed-registry-cache" \
  ROUTER_WATCHDOG_ENABLED=0 \
  ROUTER_BIN_DIR="$TEMPORARY/unreviewed-bin" \
  ROUTER_GROK_SKILLS_ROOT="$TEMPORARY/unreviewed-grok-skills" \
  "$@"
}
run_unreviewed env ROUTER_INSTALL_ATTEMPT=UNREV3 bash "$PAYLOAD/remote/install.sh" \
  --install-root "$UNREVIEWED_RUNTIME" \
  --grok-version 9.0.0 \
  --allow-unreviewed-version \
  --provider openrouter \
  --providers openrouter \
  --no-restart \
  >"$TEMPORARY/install-unreviewed.log"
grep -q 'GROKBOT_ROUTER_INSTALL_OK' "$TEMPORARY/install-unreviewed.log"
grep -q '"stockTrust": "unreviewed-anchor-verified"' "$TEMPORARY/install-unreviewed.log"
grep -q 'GROKBOT_MODEL_ROUTER_V45' "$UNREVIEWED_HOST"
cmp "$TEMPORARY/expected-unreviewed-host" "$UNREVIEWED_BACKUP"
python3 - "$UNREVIEWED_RUNTIME/provider.json" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))
assert config["grokBotVersion"] == "9.0.0", config
assert config["unreviewedVersion"] is True, config
assert config["templateManifestVersion"] == "0.36.0", config
PY
[[ -z "$(run_unreviewed "$UNREVIEWED_RUNTIME/bin/host-registry" verify 2>/dev/null)" ]]
run_unreviewed "$UNREVIEWED_RUNTIME/bin/grokbot-router" doctor >"$TEMPORARY/doctor-unreviewed.log" 2>&1
grep -q '"hostAdapterVerified": true' "$TEMPORARY/doctor-unreviewed.log"
grep -q 'HOSTTRUST=UNREVIEWED-ANCHOR-VERIFIED' "$TEMPORARY/doctor-unreviewed.log"
grep -q 'UNREVIEWED VERSION: Grok Bot 9.0.0' "$TEMPORARY/doctor-unreviewed.log"
run_unreviewed "$UNREVIEWED_RUNTIME/bin/grokbot-router" repair --no-restart >/dev/null
run_unreviewed "$UNREVIEWED_RUNTIME/bin/grokbot-router" uninstall >/dev/null
cmp "$TEMPORARY/expected-unreviewed-host" "$UNREVIEWED_HOST"

XAI_RUNTIME="$TEMPORARY/xai-runtime"
XAI_HOST="$TEMPORARY/xai-host-main.cjs"
XAI_BACKUP="$TEMPORARY/xai-backup/host-main.cjs.stock"
cp "$HOST_FIXTURE" "$XAI_HOST"
mkdir -p "$XAI_RUNTIME"
ROUTER_PATCH_HOST="$XAI_HOST" \
ROUTER_PATCH_BACKUP="$XAI_BACKUP" \
ROUTER_ALLOW_UNKNOWN_HOST=1 \
ROUTER_BIN_DIR="$TEMPORARY/xai-bin" \
ROUTER_GROK_SKILLS_ROOT="$TEMPORARY/xai-grok-skills" \
ROUTER_INSTALL_ATTEMPT=XAI1 \
bash "$PAYLOAD/remote/install.sh" \
  --install-root "$XAI_RUNTIME" \
  --provider xai \
  --providers xai,openrouter \
  --xai-model grok-build-0.1 \
  --no-restart \
  >"$TEMPORARY/install-xai.log"
grep -q 'OpenRouter/xAI-only setup needs no dependency download' "$TEMPORARY/install-xai.log"
[[ ! -d "$XAI_RUNTIME/node_modules" ]]
grep -q 'Default provider: xai' <<<"$("$TEMPORARY/xai-bin/grokbot-router" status)"
grep -q 'xAI model: grok-build-0.1' <<<"$("$TEMPORARY/xai-bin/grokbot-router" status)"
python3 - "$XAI_RUNTIME/provider.json" <<'PY'
import json
import sys

config = json.load(open(sys.argv[1]))
assert config["providers"] == ["xai", "openrouter"], config["providers"]
assert config["anthropicModel"] == "claude-sonnet-5"
assert "grok-4.6" in config["xaiModels"]
assert config["xaiBaseUrl"] == "https://api.x.ai/v1"
PY
AUTH_STATUS="$(ROUTER_PATCH_HOST="$XAI_HOST" ROUTER_PATCH_BACKUP="$XAI_BACKUP" "$TEMPORARY/xai-bin/grokbot-router" doctor 2>&1 || true)"
grep -q 'Credential: not signed in' <<<"$AUTH_STATUS"

cp "$HOST_FIXTURE" "$TEST_HOST"
mkdir -p "$TEST_RUNTIME"
printf '%s\n' '{"provider":"openrouter","openRouterModels":["openai/gpt-5.2","legacy/removed-model"]}' > "$TEST_RUNTIME/provider.json"
ROUTER_PATCH_HOST="$TEST_HOST" \
ROUTER_PATCH_BACKUP="$TEST_BACKUP" \
ROUTER_ALLOW_UNKNOWN_HOST=1 \
ROUTER_BIN_DIR="$TEST_BIN" \
ROUTER_GROK_SKILLS_ROOT="$TEST_GROK_SKILLS" \
ROUTER_INSTALL_ATTEMPT=SUCCESS45 \
bash "$PAYLOAD/remote/install.sh" \
  --install-root "$TEST_RUNTIME" \
  --grok-version 0.30.0 \
  --provider codex \
  --providers codex,openrouter \
  --no-restart \
  >"$TEMPORARY/install-success.log"

for phase in PREFLIGHT VALIDATE_PAYLOAD PREPARE_RUNTIME INSTALL_DEPENDENCIES ACTIVATE_RUNTIME APPLY_ADAPTER VERIFY_INSTALL COMPLETE; do
  grep -q "GROKROUTER_SUCCESS45_PHASE_$phase" "$TEMPORARY/install-success.log"
done

grep -q 'GROKBOT_MODEL_ROUTER_V45' "$TEST_HOST"
grep -q 'appendGrokBotRouterHostError' "$TEST_HOST"
grep -q 'getGrokBotRouterChildEnv' "$TEST_HOST"
[[ -x "$TEST_RUNTIME/node_modules/.bin/codex" ]]
[[ -L "$TEST_BIN/grokbot-router" ]]
[[ -x "$TEST_RUNTIME/bin/grokbot-router-watchdog" ]]
[[ -x "$TEST_RUNTIME/bin/host-registry" ]]
[[ -x "$TEST_RUNTIME/bin/verify-host-registry.mjs" ]]
TEST_REGISTRY_ROOT="$TEMPORARY/registry-cache"
ROUTER_HOST_REGISTRY_ROOT="$TEST_REGISTRY_ROOT" \
  "$TEST_RUNTIME/bin/host-registry" verify \
  | grep -q "$TEST_RUNTIME/compatibility/0.30.0-hosts.json"
mkdir -p "$TEST_REGISTRY_ROOT"
cp "$PAYLOAD/compatibility/0.30.0-hosts.json" "$TEST_REGISTRY_ROOT/0.30.0-hosts.json"
cp "$PAYLOAD/compatibility/0.30.0-hosts.json.sig" "$TEST_REGISTRY_ROOT/0.30.0-hosts.json.sig"
ROUTER_HOST_REGISTRY_ROOT="$TEST_REGISTRY_ROOT" \
  "$TEST_RUNTIME/bin/host-registry" verify \
  | grep -q "$TEST_REGISTRY_ROOT/0.30.0-hosts.json"
for skill_name in provider models model reasoning router doctor; do
  [[ ! -e "$TEST_GROK_SKILLS/$skill_name" && ! -L "$TEST_GROK_SKILLS/$skill_name" ]]
done
ln -s "$TEST_RUNTIME/skills/provider" "$TEST_GROK_SKILLS/provider"
mkdir "$TEST_GROK_SKILLS/reasoning"
printf 'user-owned\n' > "$TEST_GROK_SKILLS/reasoning/KEEP"
grep -q 'Default provider: codex' <<<"$("$TEST_BIN/grokbot-router" status)"
python3 - "$TEST_RUNTIME/provider.json" "$PROJECT_ROOT/runtime/provider.default.json" <<'PY'
import json
import sys

config = json.load(open(sys.argv[1]))
assert "openai/gpt-5.2" not in config["openRouterModels"]
assert "legacy/removed-model" not in config["openRouterModels"]
# The packaged catalog moves as vendors ship models; assert against the shipped
# defaults so a stale user list is always replaced by the current one.
defaults = json.load(open(sys.argv[2]))
assert config["openRouterModels"] == defaults["openRouterModels"], config["openRouterModels"]
assert config["anthropicModels"] == defaults["anthropicModels"]
assert config["xaiModels"] == defaults["xaiModels"]
assert config["codexModels"] == defaults["codexModels"]
PY
node --input-type=module - "$TEST_RUNTIME" <<'NODESTATE'
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.argv[2];
const {runTurn} = await import(pathToFileURL(join(root, 'run-provider.mjs')));
const config = JSON.parse(await readFile(join(root, 'provider.json')));
for (const [botId, text] of [['preserve-one','/provider openrouter'],['preserve-one','/model openai/gpt-5.6-luna'],['preserve-two','/provider codex'],['preserve-two','/model gpt-5.6-terra']]) {
  const result = await runTurn({config, messages:[{role:'user',content:text}], sessionOptions:{botId}});
  if (!result.control) throw new Error('State fixture must use deterministic controls');
}
await runTurn({config, messages:[{role:'user',content:'Establish thread continuity'}], sessionOptions:{botId:'preserve-two'}}, {
  codexFactory:()=>({startThread:()=>({id:'saved-upgrade-thread',run:async()=>({finalResponse:JSON.stringify({text:'THREAD_SAVED',toolCalls:[]})})})}),
});
await mkdir(join(root,'conversation-states','old.json.lock'));
await writeFile(join(root,'conversation-states','stale.tmp'),'incomplete');
NODESTATE

python3 - "$TEST_RUNTIME/provider.json" <<'PY'
import json
import sys

path = sys.argv[1]
config = json.load(open(path))
config.update({
    "provider": "openrouter",
    "providers": ["openrouter"],
    "openRouterModel": "openai/gpt-5.6-luna",
})
with open(path, "w") as output:
    json.dump(config, output)
PY
cp "$TEST_RUNTIME/audit.jsonl" "$TEMPORARY/pre-upgrade-audit"
ROUTER_PATCH_HOST="$TEST_HOST" \
ROUTER_PATCH_BACKUP="$TEST_BACKUP" \
ROUTER_ALLOW_UNKNOWN_HOST=1 \
ROUTER_BIN_DIR="$TEST_BIN" \
ROUTER_GROK_SKILLS_ROOT="$TEST_GROK_SKILLS" \
bash "$PAYLOAD/remote/install.sh" \
  --install-root "$TEST_RUNTIME" \
  --providers codex,openrouter \
  --no-restart \
  >"$TEMPORARY/install-reuse.log"
grep -q 'Reusing the already verified pinned Codex and Claude Agent SDK runtime' "$TEMPORARY/install-reuse.log"
cmp "$TEMPORARY/pre-upgrade-audit" "$TEST_RUNTIME/audit.jsonl"
node --input-type=module - "$TEST_RUNTIME" <<'NODESTATE'
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.argv[2];
const {runTurn} = await import(pathToFileURL(join(root, 'run-provider.mjs')));
const config = JSON.parse(await readFile(join(root,'provider.json')));
for (const [botId, provider, model] of [['preserve-one','openrouter','openai/gpt-5.6-luna'],['preserve-two','codex','gpt-5.6-terra'],['new-after-upgrade','openrouter','openai/gpt-5.6-luna']]) {
  const result = await runTurn({config, messages:[{role:'user',content:'/provider'}], sessionOptions:{botId}});
  assert.equal(result.provider,provider);
  assert.equal(result.model,model);
}
const resumed = await runTurn({config, messages:[{role:'user',content:'Resume the saved thread'}], sessionOptions:{botId:'preserve-two'}}, {
  codexFactory:()=>({resumeThread:(id)=>{
    assert.equal(id,'saved-upgrade-thread');
    return {id,run:async()=>({finalResponse:JSON.stringify({text:'THREAD_RESUMED',toolCalls:[]})})};
  },startThread:()=>{throw new Error('Upgrade lost the Codex thread');}}),
});
assert.equal(resumed.text,'THREAD_RESUMED');
assert.match(await readFile(join(root,'audit.jsonl'),'utf8'), /control_turn/);
await assert.rejects(stat(join(root,'conversation-states','old.json.lock')), {code:'ENOENT'});
await assert.rejects(stat(join(root,'conversation-states','stale.tmp')), {code:'ENOENT'});
NODESTATE

grep -q 'Default provider: openrouter' <<<"$("$TEST_BIN/grokbot-router" status)"
grep -q 'OpenRouter model: openai/gpt-5.6-luna' <<<"$("$TEST_BIN/grokbot-router" status)"
grep -q 'user-owned' "$TEST_GROK_SKILLS/reasoning/KEEP"
[[ ! -e "$TEST_GROK_SKILLS/provider" && ! -L "$TEST_GROK_SKILLS/provider" ]]

# Doctor's process status must agree with its real runtime and host checks.
run_test_doctor() {
  ROUTER_PATCH_HOST="$TEST_HOST" \
  ROUTER_PATCH_BACKUP="$TEST_BACKUP" \
  ROUTER_ALLOW_UNKNOWN_HOST=1 \
  ROUTER_HOST_REGISTRY_ROOT="$TEST_REGISTRY_ROOT" \
  ROUTER_HOST_REGISTRY_ALLOW_OVERRIDE=1 \
  ROUTER_HOST_REGISTRY_URL='http://unsupported-protocol.invalid/registry.json' \
  "$TEST_BIN/grokbot-router" doctor >"$1" 2>&1
}
run_test_doctor "$TEMPORARY/doctor-healthy.log"
grep -q '"hostAdapterVerified": true' "$TEMPORARY/doctor-healthy.log"
cp "$TEST_RUNTIME/run-provider.mjs" "$TEMPORARY/valid-run-provider.mjs"
printf '\nconst = broken;\n' >> "$TEST_RUNTIME/run-provider.mjs"
if run_test_doctor "$TEMPORARY/doctor-runtime-failure.log"; then
  echo 'Doctor must return failure for an invalid provider runner' >&2
  exit 1
fi
grep -q 'FAILED' "$TEMPORARY/doctor-runtime-failure.log"
cp "$TEMPORARY/valid-run-provider.mjs" "$TEST_RUNTIME/run-provider.mjs"
cp "$TEST_HOST" "$TEMPORARY/valid-adapted-host"
printf '\n// altered adapter\n' >> "$TEST_HOST"
if run_test_doctor "$TEMPORARY/doctor-host-failure.log"; then
  echo 'Doctor must return failure for an unverified adapter' >&2
  exit 1
fi
grep -q 'GROKBOT_ROUTER_DOCTOR_DONE' "$TEMPORARY/doctor-host-failure.log"
cp "$TEMPORARY/valid-adapted-host" "$TEST_HOST"
run_test_doctor "$TEMPORARY/doctor-recovered.log"

python3 "$TEST_RUNTIME/patch/router_patch.py" \
  --restore \
  --allow-unknown-host \
  --host "$TEST_HOST" \
  --backup "$TEST_BACKUP" \
  --manifest "$TEST_RUNTIME/patch/manifests/0.30.0.json" \
  --json \
  >/dev/null
cmp "$HOST_FIXTURE" "$TEST_HOST"

ROUTER_PATCH_HOST="$TEST_HOST" \
ROUTER_PATCH_BACKUP="$TEST_BACKUP" \
ROUTER_ALLOW_UNKNOWN_HOST=1 \
ROUTER_WATCHDOG_ENABLED=0 \
"$TEST_BIN/grokbot-router" repair >/dev/null
grep -q 'GROKBOT_MODEL_ROUTER_V45' "$TEST_HOST"

ROUTER_PATCH_HOST="$TEST_HOST" \
ROUTER_PATCH_BACKUP="$TEST_BACKUP" \
ROUTER_ALLOW_UNKNOWN_HOST=1 \
ROUTER_WATCHDOG_ENABLED=0 \
"$TEST_BIN/grokbot-router" repair --no-restart >"$TEMPORARY/deferred-repair.log"
grep -q 'Host restart deferred to the desktop installer' "$TEMPORARY/deferred-repair.log"
grep -q 'GROKBOT_ROUTER_REPAIR_OK' "$TEMPORARY/deferred-repair.log"

ROUTER_PATCH_HOST="$TEST_HOST" \
ROUTER_PATCH_BACKUP="$TEST_BACKUP" \
ROUTER_ALLOW_UNKNOWN_HOST=1 \
ROUTER_WATCHDOG_ENABLED=0 \
ROUTER_GROK_SKILLS_ROOT="$TEST_GROK_SKILLS" \
"$TEST_BIN/grokbot-router" uninstall >/dev/null
cmp "$HOST_FIXTURE" "$TEST_HOST"
for skill_name in provider models model router doctor; do
  [[ ! -e "$TEST_GROK_SKILLS/$skill_name" && ! -L "$TEST_GROK_SKILLS/$skill_name" ]]
done
grep -q 'user-owned' "$TEST_GROK_SKILLS/reasoning/KEEP"

# Delegation mode (Grok Bot 0.63.0+): no host, no watchdog, every control and
# task goes through the CLI that the native commands run. Exercise the real
# installer from the payload without any provider download.
DELEGATION_RUNTIME="$TEMPORARY/delegation-runtime"
DELEGATION_BIN="$TEMPORARY/delegation-bin"
DELEGATION_SKILLS="$TEMPORARY/delegation-grok-skills"
DELEGATION_HOST="$TEMPORARY/delegation-host-main.cjs"
cp "$HOST_FIXTURE" "$DELEGATION_HOST"
UNKNOWN_DELEGATION_OPTION="$(ROUTER_INSTALL_ATTEMPT=DELEG0 bash "$PAYLOAD/remote/install-delegation.sh" --not-a-real-option 2>&1 || true)"
grep -q 'GROKROUTER_DELEG0_INSTALL_FAILED_OPTIONS_UNKNOWN_OPTION' <<<"$UNKNOWN_DELEGATION_OPTION"
OLD_VERSION_FAILURE="$(ROUTER_INSTALL_ATTEMPT=DELEG1 bash "$PAYLOAD/remote/install-delegation.sh" --install-root "$DELEGATION_RUNTIME" --grok-version 0.44.0 2>&1 || true)"
grep -q 'GROKROUTER_DELEG1_INSTALL_FAILED_OPTIONS_UNSUPPORTED_VERSION' <<<"$OLD_VERSION_FAILURE"
[[ ! -e "$DELEGATION_RUNTIME" ]]
for rejected_option in "--provider gemini INVALID_PROVIDER" "--providers codex,gemini INVALID_PROVIDERS" "--reasoning extreme INVALID_REASONING" "--workspace relative/path INVALID_WORKSPACE" "--anthropic-model claude|sh INVALID_ANTHROPIC_MODEL"; do
  read -r option_name option_value option_code <<<"$rejected_option"
  OPTION_FAILURE="$(ROUTER_INSTALL_ATTEMPT=DELEG2 bash "$PAYLOAD/remote/install-delegation.sh" --install-root "$DELEGATION_RUNTIME" "$option_name" "$option_value" 2>&1 || true)"
  grep -q "GROKROUTER_DELEG2_INSTALL_FAILED_OPTIONS_$option_code" <<<"$OPTION_FAILURE"
done
mkdir -p "$DELEGATION_SKILLS/reasoning"
printf 'user-owned\n' > "$DELEGATION_SKILLS/reasoning/KEEP"
CHAT_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
CHAT_AUTOSTART="$TEMPORARY/grokbot-router-chat.desktop"
export ROUTER_CHAT_PORT="$CHAT_PORT" ROUTER_CHAT_AUTOSTART="$CHAT_AUTOSTART"
ROUTER_PATCH_HOST="$DELEGATION_HOST" \
ROUTER_BIN_DIR="$DELEGATION_BIN" \
ROUTER_GROK_SKILLS_ROOT="$DELEGATION_SKILLS" \
ROUTER_INSTALL_ATTEMPT=DELEG3 \
bash "$PAYLOAD/remote/install-delegation.sh" \
  --install-root "$DELEGATION_RUNTIME" \
  --grok-version 0.63.0 \
  --provider openrouter \
  --providers openrouter,xai \
  --openrouter-model anthropic/claude-opus-5.5 \
  --reasoning xhigh \
  >"$TEMPORARY/install-delegation.log" 2>&1
for phase in PREFLIGHT VALIDATE_PAYLOAD PREPARE_RUNTIME INSTALL_DEPENDENCIES ACTIVATE_RUNTIME REGISTER_COMMANDS VERIFY_INSTALL COMPLETE; do
  grep -q "GROKROUTER_DELEG3_PHASE_$phase" "$TEMPORARY/install-delegation.log"
done
grep -q 'GROKBOT_ROUTER_INSTALL_OK' "$TEMPORARY/install-delegation.log"
grep -q 'Payload integrity manifest verified' "$TEMPORARY/install-delegation.log"
grep -q 'Mode: delegation (Grok Bot 0.63.0; the host is not patched)' "$TEMPORARY/install-delegation.log"
grep -q 'OpenRouter is active for this bot. Model: anthropic/claude-opus-5.5. Reasoning: xhigh.' "$TEMPORARY/install-delegation.log"
! grep -q 'GROKROUTER_DELEG3_PHASE_APPLY_ADAPTER' "$TEMPORARY/install-delegation.log"
# The zero-Grok chat UI starts with the runtime, needs the token, and is
# stopped by uninstall. The autostart entry is only written on a real install.
grep -q "Zero-Grok chat: open http://127.0.0.1:$CHAT_PORT/?token=" "$TEMPORARY/install-delegation.log"
[[ ! -e "$CHAT_AUTOSTART" ]]
[[ -f "$TEMPORARY/grokbot-router-chat.pid" ]]
CHAT_TOKEN="$(cat "$DELEGATION_RUNTIME/chat-token")"
[[ "$CHAT_TOKEN" =~ ^[A-Za-z0-9_-]{16,}$ ]]
grep -q "http://127.0.0.1:$CHAT_PORT/?token=$CHAT_TOKEN" <<<"$("$DELEGATION_BIN/grokbot-router" chat)"
grep -q 'Chat server running' <<<"$("$DELEGATION_BIN/grokbot-router" serve --status)"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CHAT_PORT/api/health")" == "401" ]]
grep -q '"mode":"delegation"' <<<"$(curl -s -H "Authorization: Bearer $CHAT_TOKEN" "http://127.0.0.1:$CHAT_PORT/api/health")"
grep -q 'GrokRouter Chat' <<<"$(curl -s "http://127.0.0.1:$CHAT_PORT/")"
grep -q '"name":"grokrouter"' <<<"$(curl -s -X POST -H "Authorization: Bearer $CHAT_TOKEN" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "http://127.0.0.1:$CHAT_PORT/mcp")"
grep -q '"delegate"' <<<"$(curl -s -X POST -H "Authorization: Bearer $CHAT_TOKEN" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "http://127.0.0.1:$CHAT_PORT/mcp")"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' "http://127.0.0.1:$CHAT_PORT/mcp")" == "401" ]]
grep -q 'Tailscale: not installed' <<<"$(ROUTER_TAILNET_AUTOSTART="$TEMPORARY/tailnet.desktop" "$DELEGATION_BIN/grokbot-router" tailscale status)"
[[ ! -e "$TEMPORARY/tailnet.desktop" ]]
grep -q 'tailscale up' "$TEMPORARY/install-delegation.log"
CHAT_CREATED="$(curl -s -X POST -H "Authorization: Bearer $CHAT_TOKEN" -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$CHAT_PORT/api/chats")"
grep -q '"provider":"openrouter"' <<<"$CHAT_CREATED"
CHAT_ID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["chat"]["id"])' "$CHAT_CREATED")"
grep -q 'to xAI (grok-4.6)' <<<"$(curl -s -X POST -H "Authorization: Bearer $CHAT_TOKEN" -H 'content-type: application/json' -d '{"text":"/provider xai"}' "http://127.0.0.1:$CHAT_PORT/api/chats/$CHAT_ID/messages")"
grep -q 'xAI is active for this bot' <<<"$("$DELEGATION_BIN/grokbot-router" bot "chat:$CHAT_ID")"
cmp "$HOST_FIXTURE" "$DELEGATION_HOST"
[[ ! -d "$DELEGATION_RUNTIME/node_modules" ]]
[[ ! -e "$DELEGATION_RUNTIME/patch" ]]
[[ ! -e "$DELEGATION_RUNTIME/bin/grokbot-router-watchdog" ]]
[[ -f "$DELEGATION_RUNTIME/delegate.mjs" ]]
[[ -L "$DELEGATION_BIN/grokbot-router" ]]
# macOS temporary directories are symlinked (/var -> /private/var); compare physical paths.
DELEGATION_RUNTIME_PHYSICAL="$(cd -P "$DELEGATION_RUNTIME" && pwd -P)"
for skill_name in provider models model router doctor route; do
  [[ -L "$DELEGATION_SKILLS/$skill_name" ]]
  [[ "$(readlink "$DELEGATION_SKILLS/$skill_name")" == "$DELEGATION_RUNTIME_PHYSICAL/skills/$skill_name" ]]
done
[[ ! -L "$DELEGATION_SKILLS/reasoning" ]]
grep -q 'user-owned' "$DELEGATION_SKILLS/reasoning/KEEP"
python3 - "$DELEGATION_RUNTIME/provider.json" "$PROJECT_ROOT/runtime/provider.default.json" <<'PY'
import json
import sys

config = json.load(open(sys.argv[1]))
defaults = json.load(open(sys.argv[2]))
assert config["mode"] == "delegation", config.get("mode")
assert config["enabled"] is True and config["autoRepair"] is False
assert config["grokBotVersion"] == "0.63.0"
assert config["grokBotSupport"] == ">=0.63.0"
assert config["provider"] == "openrouter"
assert config["providers"] == ["openrouter", "xai"], config["providers"]
assert config["openRouterModel"] == "anthropic/claude-opus-5.5"
assert config["openRouterReasoning"] == "xhigh"
assert config["workingDirectory"] == "/workspace"
assert config["delegationRunnerPath"].endswith("/delegate.mjs")
assert "unreviewedVersion" not in config and "templateManifestVersion" not in config
assert config["anthropicModels"] == defaults["anthropicModels"]
assert "claude-opus-5-5" in config["anthropicModels"]
PY
DELEGATION_STATUS="$("$DELEGATION_BIN/grokbot-router" status)"
grep -q 'Mode: delegation' <<<"$DELEGATION_STATUS"
grep -q 'Default provider: openrouter' <<<"$DELEGATION_STATUS"
grep -q 'OpenRouter is active for this bot. Model: anthropic/claude-opus-5.5. Reasoning: xhigh.' <<<"$("$DELEGATION_BIN/grokbot-router" bot)"
grep -q 'to xAI (grok-4.6)' <<<"$("$DELEGATION_BIN/grokbot-router" control "/provider xai")"
grep -q 'xAI is active for this bot. Model: grok-4.6. Reasoning: medium.' <<<"$("$DELEGATION_BIN/grokbot-router" bot)"
grep -q 'Reasoning effort' <<<"$("$DELEGATION_BIN/grokbot-router" control "/reasoning xhigh")"
grep -q 'Reasoning: xhigh' <<<"$("$DELEGATION_BIN/grokbot-router" bot)"
# Every Bot keeps its own selection: another Bot still sees the defaults.
grep -q 'OpenRouter is active for this bot. Model: anthropic/claude-opus-5.5. Reasoning: xhigh.' <<<"$("$DELEGATION_BIN/grokbot-router" bot other-bot)"
grep -q 'no host restart needed' <<<"$(ROUTER_PATCH_HOST="$DELEGATION_HOST" "$DELEGATION_BIN/grokbot-router" model xai grok-4.5)"
grep -q 'xAI model: grok-4.5' <<<"$("$DELEGATION_BIN/grokbot-router" status)"
grep -q 'Delegation mode does not patch or restart the host' <<<"$("$DELEGATION_BIN/grokbot-router" restart)"
grep -q 'delegation mode' <<<"$("$DELEGATION_BIN/grokbot-router" disable)"
if "$DELEGATION_BIN/grokbot-router" run --task "reply with exactly PING" >"$TEMPORARY/delegation-run.out" 2>"$TEMPORARY/delegation-run.err"; then
  echo 'A disabled delegation router must refuse tasks' >&2
  exit 1
fi
grep -q 'GrokRouter is disabled' "$TEMPORARY/delegation-run.err"
[[ ! -s "$TEMPORARY/delegation-run.out" ]]
grep -q 'Router enabled (delegation mode)' <<<"$("$DELEGATION_BIN/grokbot-router" enable)"
grep -q 'nothing to repair' <<<"$("$DELEGATION_BIN/grokbot-router" repair)"
DELEGATION_DOCTOR_CONTROL="$("$DELEGATION_BIN/grokbot-router" control "/doctor")"
grep -q 'Delegated tasks: local shell/read/write/list tool loop in /workspace' <<<"$DELEGATION_DOCTOR_CONTROL"
! grep -q 'Grok tools: bridged' <<<"$DELEGATION_DOCTOR_CONTROL"
ROUTER_GROK_SKILLS_ROOT="$DELEGATION_SKILLS" "$DELEGATION_BIN/grokbot-router" doctor >"$TEMPORARY/delegation-doctor.log" 2>&1
grep -q 'Delegation runner: OK' "$TEMPORARY/delegation-doctor.log"
grep -q 'xAI is active for this bot' "$TEMPORARY/delegation-doctor.log"
grep -q "Chat server" "$TEMPORARY/delegation-doctor.log"
grep -q "running (pid" "$TEMPORARY/delegation-doctor.log"
grep -q '/route: linked' "$TEMPORARY/delegation-doctor.log"
grep -q '/reasoning: user-owned definition' "$TEMPORARY/delegation-doctor.log"
grep -q 'GROKBOT_ROUTER_DOCTOR_DONE' "$TEMPORARY/delegation-doctor.log"
! grep -q 'Host adapter' "$TEMPORARY/delegation-doctor.log"
! grep -q 'Host seam' "$TEMPORARY/delegation-doctor.log"
cmp "$HOST_FIXTURE" "$DELEGATION_HOST"

# Upgrading in place keeps the default provider, the per-Bot selection, the
# thread state and the audit log, and refreshes the packaged runtime.
cp "$DELEGATION_RUNTIME/audit.jsonl" "$TEMPORARY/delegation-pre-upgrade-audit"
printf '\n// stale runtime\n' >> "$DELEGATION_RUNTIME/delegate.mjs"
ROUTER_BIN_DIR="$DELEGATION_BIN" \
ROUTER_GROK_SKILLS_ROOT="$DELEGATION_SKILLS" \
bash "$PAYLOAD/remote/install-delegation.sh" --install-root "$DELEGATION_RUNTIME" >"$TEMPORARY/install-delegation-upgrade.log" 2>&1
grep -q 'GROKBOT_ROUTER_INSTALL_OK' "$TEMPORARY/install-delegation-upgrade.log"
cmp "$PAYLOAD/runtime/delegate.mjs" "$DELEGATION_RUNTIME/delegate.mjs"
[[ "$(cat "$DELEGATION_RUNTIME/chat-token")" == "$CHAT_TOKEN" ]]
[[ -f "$DELEGATION_RUNTIME/chats/$CHAT_ID.json" ]]
grep -q 'Chat server running' <<<"$("$DELEGATION_BIN/grokbot-router" serve --status)"
cmp "$TEMPORARY/delegation-pre-upgrade-audit" "$DELEGATION_RUNTIME/audit.jsonl"
grep -q 'xAI is active for this bot. Model: grok-4.6. Reasoning: xhigh.' <<<"$("$DELEGATION_BIN/grokbot-router" bot)"
grep -q 'Default provider: openrouter' <<<"$("$DELEGATION_BIN/grokbot-router" status)"
grep -q 'Grok Bot version: 0.63.0' <<<"$("$DELEGATION_BIN/grokbot-router" status)"
[[ "$(readlink "$DELEGATION_SKILLS/route")" == "$DELEGATION_RUNTIME_PHYSICAL/skills/route" ]]

ROUTER_GROK_SKILLS_ROOT="$DELEGATION_SKILLS" "$DELEGATION_BIN/grokbot-router" uninstall >"$TEMPORARY/delegation-uninstall.log"
grep -q 'GROKBOT_ROUTER_UNINSTALL_OK' "$TEMPORARY/delegation-uninstall.log"
[[ ! -f "$TEMPORARY/grokbot-router-chat.pid" ]]
if "$DELEGATION_BIN/grokbot-router" serve --status >/dev/null 2>&1; then
  echo 'Uninstall must stop the chat server' >&2
  exit 1
fi
for skill_name in provider models model router doctor route; do
  [[ ! -e "$DELEGATION_SKILLS/$skill_name" && ! -L "$DELEGATION_SKILLS/$skill_name" ]]
done
grep -q 'user-owned' "$DELEGATION_SKILLS/reasoning/KEEP"
grep -q 'Enabled: False' <<<"$("$DELEGATION_BIN/grokbot-router" status)"
cmp "$HOST_FIXTURE" "$DELEGATION_HOST"

# The one-line Bot terminal installer hands every option to the delegation
# installer from a local checkout without downloading anything.
BOOTSTRAP_RUNTIME="$TEMPORARY/bootstrap-runtime"
ROUTER_BIN_DIR="$TEMPORARY/bootstrap-bin" \
ROUTER_GROK_SKILLS_ROOT="$TEMPORARY/bootstrap-grok-skills" \
bash "$PROJECT_ROOT/scripts/install-bot.sh" --install-root "$BOOTSTRAP_RUNTIME" --provider xai --providers xai --no-chat >"$TEMPORARY/install-bot.log" 2>&1
! grep -q 'Zero-Grok chat' "$TEMPORARY/install-bot.log"
grep -q 'GROKBOT_ROUTER_INSTALL_OK' "$TEMPORARY/install-bot.log"
grep -q 'Source checkout: no payload integrity manifest to verify' "$TEMPORARY/install-bot.log"
grep -q 'Default provider: xai' <<<"$("$TEMPORARY/bootstrap-bin/grokbot-router" status)"
grep -q 'swcstudiospace/grokrouter' "$PROJECT_ROOT/scripts/install-bot.sh"
grep -q 'remote/install-delegation.sh' "$PROJECT_ROOT/scripts/install-bot.sh"
grep -Fq 'curl -fsSL https://raw.githubusercontent.com/swcstudiospace/grokrouter/main/scripts/install-bot.sh | bash -s --' "$PROJECT_ROOT/README.md"
grep -Fq 'curl -fsSL https://raw.githubusercontent.com/swcstudiospace/grokrouter/main/scripts/register-commands.sh | bash' "$PROJECT_ROOT/README.md"
grep -Fq 'scripts/register-commands.sh | bash' "$PROJECT_ROOT/remote/install-delegation.sh"
grep -q 'register-native-commands.mjs' "$PROJECT_ROOT/scripts/register-commands.sh"
grep -q '^/route: ' <<<"$(node "$PROJECT_ROOT/scripts/register-native-commands.mjs" --print)"

printf 'Installer and payload checks passed.\n'
