#!/usr/bin/env bash
set -Eeuo pipefail

# GrokRouter delegation-mode installer for Grok Bot 0.63.0 and newer.
#
# Grok Bot 0.62.0+ runs chat inference outside the Bot computer, so the legacy
# host adapter (remote/install.sh) has nothing to intercept there. This
# installer never reads or modifies Grok's host. It installs the runtime, the
# grokbot-router CLI and the native /route, /provider, /model, /models,
# /reasoning, /router and /doctor commands; Grok delegates tasks to the chosen
# provider by running `grokbot-router run` in this Bot computer.

ROUTER_VERSION="0.1.0-beta.48"
MINIMUM_GROK_VERSION="0.63.0"
PAYLOAD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="/home/box/sand-data/grokbot-router"
INSTALL_PARENT="/home/box/sand-data"
GROK_VERSION=""
DEFAULT_PROVIDER="codex"
CODEX_MODEL="gpt-5.6-sol"
OPENROUTER_MODEL="anthropic/claude-sonnet-5"
ANTHROPIC_MODEL="claude-sonnet-5"
XAI_MODEL="grok-4.6"
DEFAULT_REASONING=""
WORKSPACE="/workspace"
ENABLED_PROVIDERS="codex,openrouter,anthropic,xai"
KNOWN_PROVIDERS="codex openrouter anthropic xai"
PROVIDER_EXPLICIT=0
PROVIDERS_EXPLICIT=0
CODEX_MODEL_EXPLICIT=0
OPENROUTER_MODEL_EXPLICIT=0
ANTHROPIC_MODEL_EXPLICIT=0
XAI_MODEL_EXPLICIT=0
WORKSPACE_EXPLICIT=0
MANAGE_LEGACY=1
START_CHAT=1
CHAT_PORT="${ROUTER_CHAT_PORT:-7878}"
CHAT_AUTOSTART="${ROUTER_CHAT_AUTOSTART:-/home/box/.config/autostart/grokbot-router-chat.desktop}"
GROK_SKILLS_ROOT="${ROUTER_GROK_SKILLS_ROOT:-/home/box/.grok/skills}"
INSTALL_ATTEMPT="${ROUTER_INSTALL_ATTEMPT:-LOCAL}"
INSTALL_PHASE="OPTIONS"
SKILL_NAMES="provider models model reasoning router doctor route"

if [[ ! "$INSTALL_ATTEMPT" =~ ^[A-Z0-9]{4,16}$ ]]; then
  INSTALL_ATTEMPT="LOCAL"
fi

emit_phase() {
  INSTALL_PHASE="$1"
  printf '\nGROKROUTER_%s_PHASE_%s\n' "$INSTALL_ATTEMPT" "$INSTALL_PHASE"
}

fail_install() {
  local code="$1"
  shift
  trap - ERR
  printf 'ERROR: %s\n' "$*" >&2
  printf 'GROKROUTER_%s_INSTALL_FAILED_%s_%s\n' "$INSTALL_ATTEMPT" "$INSTALL_PHASE" "$code" >&2
  exit 1
}

report_unhandled_error() {
  local status=$?
  trap - ERR
  printf '\nGROKROUTER_%s_INSTALL_FAILED_%s_COMMAND_%s\n' "$INSTALL_ATTEMPT" "$INSTALL_PHASE" "$status" >&2
  exit "$status"
}

trap report_unhandled_error ERR

usage() {
  printf '%s\n' \
    "GrokRouter delegation installer ${ROUTER_VERSION} (Grok Bot ${MINIMUM_GROK_VERSION} and newer)" \
    "" \
    "Usage: install-delegation.sh [options]" \
    "  --grok-version VERSION       Record the installed Grok Bot version (${MINIMUM_GROK_VERSION} or newer)" \
    "  --provider codex|openrouter|anthropic|xai" \
    "  --providers comma-separated subset of codex,openrouter,anthropic,xai" \
    "  --codex-model MODEL" \
    "  --openrouter-model vendor/model" \
    "  --anthropic-model MODEL" \
    "  --xai-model MODEL" \
    "  --reasoning minimal|low|medium|high|xhigh" \
    "                               Default reasoning effort for the default provider" \
    "  --workspace DIR              Directory delegated tasks run in (default /workspace)" \
    "  --no-chat                    Do not start the zero-Grok chat UI (grokbot-router serve)" \
    "  --install-root PATH          Development/testing only"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --grok-version)
      GROK_VERSION="${2:?missing Grok Bot version}"
      shift 2
      ;;
    --provider)
      DEFAULT_PROVIDER="${2:?missing provider}"
      PROVIDER_EXPLICIT=1
      shift 2
      ;;
    --providers)
      ENABLED_PROVIDERS="${2:?missing providers}"
      PROVIDERS_EXPLICIT=1
      shift 2
      ;;
    --codex-model)
      CODEX_MODEL="${2:?missing Codex model}"
      CODEX_MODEL_EXPLICIT=1
      shift 2
      ;;
    --openrouter-model)
      OPENROUTER_MODEL="${2:?missing OpenRouter model}"
      OPENROUTER_MODEL_EXPLICIT=1
      shift 2
      ;;
    --anthropic-model)
      ANTHROPIC_MODEL="${2:?missing Anthropic model}"
      ANTHROPIC_MODEL_EXPLICIT=1
      shift 2
      ;;
    --xai-model)
      XAI_MODEL="${2:?missing xAI model}"
      XAI_MODEL_EXPLICIT=1
      shift 2
      ;;
    --reasoning)
      DEFAULT_REASONING="${2:?missing reasoning effort}"
      shift 2
      ;;
    --workspace)
      WORKSPACE="${2:?missing workspace directory}"
      WORKSPACE_EXPLICIT=1
      shift 2
      ;;
    --no-chat)
      START_CHAT=0
      shift
      ;;
    --install-root)
      INSTALL_ROOT="${2:?missing install root}"
      INSTALL_PARENT="$(dirname "$INSTALL_ROOT")"
      MANAGE_LEGACY=0
      shift 2
      ;;
    --no-restart)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail_install "UNKNOWN_OPTION" "unknown option $1"
      ;;
  esac
done

is_known_provider() {
  local candidate
  for candidate in $KNOWN_PROVIDERS; do
    [[ "$1" == "$candidate" ]] && return 0
  done
  return 1
}
version_at_least() {
  python3 - "$1" "$2" <<'PY'
import sys
key = lambda value: tuple(int(part) for part in value.split("."))
raise SystemExit(0 if key(sys.argv[1]) >= key(sys.argv[2]) else 1)
PY
}
if ! is_known_provider "$DEFAULT_PROVIDER"; then
  fail_install "INVALID_PROVIDER" "--provider must be one of: ${KNOWN_PROVIDERS// /, }"
fi
PLAIN_MODEL_PATTERN='^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$'
OPENROUTER_MODEL_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$'
if [[ ! "$CODEX_MODEL" =~ $PLAIN_MODEL_PATTERN ]]; then
  fail_install "INVALID_CODEX_MODEL" "--codex-model must be a plain model ID"
fi
if [[ ! "$OPENROUTER_MODEL" =~ $OPENROUTER_MODEL_PATTERN ]]; then
  fail_install "INVALID_OPENROUTER_MODEL" "--openrouter-model must use vendor/model format"
fi
if [[ ! "$ANTHROPIC_MODEL" =~ $PLAIN_MODEL_PATTERN ]]; then
  fail_install "INVALID_ANTHROPIC_MODEL" "--anthropic-model must be a plain model ID"
fi
if [[ ! "$XAI_MODEL" =~ $PLAIN_MODEL_PATTERN ]]; then
  fail_install "INVALID_XAI_MODEL" "--xai-model must be a plain model ID"
fi
if [[ -n "$DEFAULT_REASONING" && ! "$DEFAULT_REASONING" =~ ^(minimal|low|medium|high|xhigh)$ ]]; then
  fail_install "INVALID_REASONING" "--reasoning must be one of: minimal, low, medium, high, xhigh"
fi
if [[ "$WORKSPACE" != /* || "$WORKSPACE" =~ [[:space:]] ]]; then
  fail_install "INVALID_WORKSPACE" "--workspace must be an absolute path without spaces"
fi
if [[ -n "$GROK_VERSION" ]]; then
  if [[ ! "$GROK_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    fail_install "INVALID_VERSION" "--grok-version must be an exact X.Y.Z version"
  fi
  if ! version_at_least "$GROK_VERSION" "$MINIMUM_GROK_VERSION"; then
    fail_install "UNSUPPORTED_VERSION" "Grok Bot $GROK_VERSION predates delegation mode; ${MINIMUM_GROK_VERSION} or newer is required. Older versions use the deprecated remote/install.sh host adapter."
  fi
fi
if [[ -z "$ENABLED_PROVIDERS" ]]; then
  fail_install "INVALID_PROVIDERS" "--providers must list at least one provider"
fi
IFS=',' read -r -a enabled_provider_list <<< "$ENABLED_PROVIDERS"
for enabled_provider in "${enabled_provider_list[@]}"; do
  if ! is_known_provider "$enabled_provider"; then
    fail_install "INVALID_PROVIDERS" "--providers must be a comma-separated subset of: ${KNOWN_PROVIDERS// /, }"
  fi
done

emit_phase "PREFLIGHT"
for command_name in node npm python3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail_install "MISSING_COMMAND" "required command is missing: $command_name"
  fi
done
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CHECK=(sha256sum -c)
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CHECK=(shasum -a 256 -c)
else
  fail_install "MISSING_COMMAND" "required command is missing: sha256sum"
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 18 )); then
  fail_install "NODE_TOO_OLD" "Node.js 18 or newer is required; found $(node -v)"
fi

mkdir -p "$INSTALL_PARENT"
STAGE_ROOT="$(mktemp -d "$INSTALL_PARENT/.grokbot-router-stage.XXXXXX")"
PREVIOUS_ROOT=""
cleanup() {
  if [[ -n "$STAGE_ROOT" && -d "$STAGE_ROOT" ]]; then
    rm -rf "$STAGE_ROOT"
  fi
}
trap cleanup EXIT

emit_phase "VALIDATE_PAYLOAD"
printf '[1/7] Validating payload\n'
if [[ -f "$PAYLOAD_ROOT/SHA256SUMS" ]]; then
  (cd "$PAYLOAD_ROOT" && "${SHA256_CHECK[@]}" SHA256SUMS >/dev/null)
  printf 'Payload integrity manifest verified.\n'
else
  printf 'Source checkout: no payload integrity manifest to verify.\n'
fi
for required in \
  "$PAYLOAD_ROOT/runtime/run-provider.mjs" \
  "$PAYLOAD_ROOT/runtime/delegate.mjs" \
  "$PAYLOAD_ROOT/runtime/serve.mjs" \
  "$PAYLOAD_ROOT/runtime/chat.html" \
  "$PAYLOAD_ROOT/runtime/tailnet.mjs" \
  "$PAYLOAD_ROOT/runtime/openrouter-catalog.mjs" \
  "$PAYLOAD_ROOT/runtime/xai-oauth.mjs" \
  "$PAYLOAD_ROOT/runtime/model-catalog.mjs" \
  "$PAYLOAD_ROOT/runtime/package.json" \
  "$PAYLOAD_ROOT/runtime/package-lock.json" \
  "$PAYLOAD_ROOT/runtime/provider.default.json" \
  "$PAYLOAD_ROOT/remote/grokbot-router"; do
  if [[ ! -f "$required" ]]; then
    fail_install "INCOMPLETE_PAYLOAD" "payload is incomplete: $required"
  fi
done
for skill_name in $SKILL_NAMES; do
  if [[ ! -f "$PAYLOAD_ROOT/skills/$skill_name/SKILL.md" ]]; then
    fail_install "MISSING_COMMAND_DEFINITION" "payload is missing the /$skill_name native command definition"
  fi
done

emit_phase "PREPARE_RUNTIME"
printf '[2/7] Preparing isolated runtime\n'
cp "$PAYLOAD_ROOT/runtime/run-provider.mjs" "$STAGE_ROOT/run-provider.mjs"
cp "$PAYLOAD_ROOT/runtime/delegate.mjs" "$STAGE_ROOT/delegate.mjs"
cp "$PAYLOAD_ROOT/runtime/serve.mjs" "$STAGE_ROOT/serve.mjs"
cp "$PAYLOAD_ROOT/runtime/chat.html" "$STAGE_ROOT/chat.html"
cp "$PAYLOAD_ROOT/runtime/tailnet.mjs" "$STAGE_ROOT/tailnet.mjs"
cp "$PAYLOAD_ROOT/runtime/openrouter-catalog.mjs" "$STAGE_ROOT/openrouter-catalog.mjs"
cp "$PAYLOAD_ROOT/runtime/xai-oauth.mjs" "$STAGE_ROOT/xai-oauth.mjs"
cp "$PAYLOAD_ROOT/runtime/model-catalog.mjs" "$STAGE_ROOT/model-catalog.mjs"
cp "$PAYLOAD_ROOT/runtime/package.json" "$STAGE_ROOT/package.json"
cp "$PAYLOAD_ROOT/runtime/package-lock.json" "$STAGE_ROOT/package-lock.json"
cp "$PAYLOAD_ROOT/runtime/provider.default.json" "$STAGE_ROOT/provider.json"
mkdir -p "$STAGE_ROOT/bin" "$STAGE_ROOT/skills"
cp "$PAYLOAD_ROOT/remote/grokbot-router" "$STAGE_ROOT/bin/grokbot-router"
cp -R "$PAYLOAD_ROOT/skills/." "$STAGE_ROOT/skills/"
chmod 700 "$STAGE_ROOT/bin/grokbot-router"

if [[ -f "$INSTALL_ROOT/provider.json" ]]; then
  cp "$INSTALL_ROOT/provider.json" "$STAGE_ROOT/provider.json"
fi

ROUTER_GROK_VERSION="$GROK_VERSION" \
ROUTER_MINIMUM_GROK_VERSION="$MINIMUM_GROK_VERSION" \
ROUTER_CONFIG_PATH="$STAGE_ROOT/provider.json" \
ROUTER_DEFAULT_CONFIG_PATH="$PAYLOAD_ROOT/runtime/provider.default.json" \
ROUTER_INSTALL_ROOT="$INSTALL_ROOT" \
ROUTER_PROVIDER="$DEFAULT_PROVIDER" \
ROUTER_PROVIDER_EXPLICIT="$PROVIDER_EXPLICIT" \
ROUTER_PROVIDERS="$ENABLED_PROVIDERS" \
ROUTER_PROVIDERS_EXPLICIT="$PROVIDERS_EXPLICIT" \
ROUTER_CODEX_MODEL="$CODEX_MODEL" \
ROUTER_CODEX_MODEL_EXPLICIT="$CODEX_MODEL_EXPLICIT" \
ROUTER_OPENROUTER_MODEL="$OPENROUTER_MODEL" \
ROUTER_OPENROUTER_MODEL_EXPLICIT="$OPENROUTER_MODEL_EXPLICIT" \
ROUTER_ANTHROPIC_MODEL="$ANTHROPIC_MODEL" \
ROUTER_ANTHROPIC_MODEL_EXPLICIT="$ANTHROPIC_MODEL_EXPLICIT" \
ROUTER_XAI_MODEL="$XAI_MODEL" \
ROUTER_XAI_MODEL_EXPLICIT="$XAI_MODEL_EXPLICIT" \
ROUTER_REASONING="$DEFAULT_REASONING" \
ROUTER_WORKSPACE="$WORKSPACE" \
ROUTER_WORKSPACE_EXPLICIT="$WORKSPACE_EXPLICIT" \
ROUTER_KNOWN_PROVIDERS="$KNOWN_PROVIDERS" \
python3 - <<'PY'
import json
import os
import re
from pathlib import Path

path = Path(os.environ["ROUTER_CONFIG_PATH"])
defaults_path = Path(os.environ["ROUTER_DEFAULT_CONFIG_PATH"])
try:
    config = json.loads(path.read_text())
except Exception:
    config = {}
defaults = json.loads(defaults_path.read_text())
install_root = os.environ["ROUTER_INSTALL_ROOT"]
known_providers = set(os.environ["ROUTER_KNOWN_PROVIDERS"].split())
version_key = lambda value: tuple(int(part) for part in value.split("."))
minimum = os.environ["ROUTER_MINIMUM_GROK_VERSION"]
grok_version = os.environ["ROUTER_GROK_VERSION"]
recorded = config.get("grokBotVersion")
if grok_version:
    config["grokBotVersion"] = grok_version
elif isinstance(recorded, str) and re.match(r"^\d+\.\d+\.\d+$", recorded) and version_key(recorded) >= version_key(minimum):
    pass
else:
    config.pop("grokBotVersion", None)
for stale in ("unreviewedVersion", "templateManifestVersion"):
    config.pop(stale, None)
provider = os.environ["ROUTER_PROVIDER"]
if os.environ["ROUTER_PROVIDER_EXPLICIT"] != "1" and config.get("provider") in known_providers:
    provider = config["provider"]
providers = list(dict.fromkeys(os.environ["ROUTER_PROVIDERS"].split(",")))
if os.environ["ROUTER_PROVIDERS_EXPLICIT"] != "1":
    existing = config.get("providers")
    if isinstance(existing, list) and existing and all(item in known_providers for item in existing):
        providers = list(dict.fromkeys(existing))
if provider not in providers:
    providers.insert(0, provider)
models = {}
for key, env_name in (("codexModel", "CODEX"), ("openRouterModel", "OPENROUTER"), ("anthropicModel", "ANTHROPIC"), ("xaiModel", "XAI")):
    value = os.environ[f"ROUTER_{env_name}_MODEL"]
    if os.environ[f"ROUTER_{env_name}_MODEL_EXPLICIT"] != "1" and isinstance(config.get(key), str):
        value = config[key]
    models[key] = value
workspace = os.environ["ROUTER_WORKSPACE"]
if os.environ["ROUTER_WORKSPACE_EXPLICIT"] != "1" and isinstance(config.get("workingDirectory"), str) and config["workingDirectory"].startswith("/"):
    workspace = config["workingDirectory"]
config.update({
    "mode": "delegation",
    "grokBotSupport": f">={minimum}",
    "enabled": True,
    "autoRepair": False,
    "provider": provider,
    "providers": providers,
    **models,
    "workingDirectory": workspace,
    "codexModels": defaults.get("codexModels", []),
    "openRouterModels": defaults.get("openRouterModels", []),
    "anthropicModels": defaults.get("anthropicModels", []),
    "xaiModels": defaults.get("xaiModels", []),
    "xaiSubscriptionModels": defaults.get("xaiSubscriptionModels", []),
    "xaiBaseUrl": defaults.get("xaiBaseUrl", "https://api.x.ai/v1"),
    "runnerPath": f"{install_root}/run-provider.mjs",
    "delegationRunnerPath": f"{install_root}/delegate.mjs",
    "nodePath": "/usr/bin/node",
    "statePath": f"{install_root}/conversation-states.json",
    "auditPath": f"{install_root}/audit.jsonl",
})
reasoning = os.environ["ROUTER_REASONING"]
if reasoning:
    reasoning_key = {"codex": "codexReasoning", "openrouter": "openRouterReasoning", "anthropic": "anthropicReasoning", "xai": "xaiReasoning"}[provider]
    config[reasoning_key] = reasoning
path.write_text(json.dumps(config, indent=2) + "\n")
path.chmod(0o600)
PY

DEFAULT_PROVIDER="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["provider"])' "$STAGE_ROOT/provider.json")"
ENABLED_PROVIDERS="$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["providers"]))' "$STAGE_ROOT/provider.json")"

emit_phase "INSTALL_DEPENDENCIES"
if [[ "$ENABLED_PROVIDERS" == *codex* || "$ENABLED_PROVIDERS" == *anthropic* ]]; then
  dependencies_reused=0
  native_platform="$(node -p 'process.platform + "-" + process.arch')"
  codex_native_package=""
  case "$native_platform" in
    linux-x64) codex_native_package="codex-linux-x64" ;;
    linux-arm64) codex_native_package="codex-linux-arm64" ;;
    darwin-x64) codex_native_package="codex-darwin-x64" ;;
    darwin-arm64) codex_native_package="codex-darwin-arm64" ;;
    win32-x64) codex_native_package="codex-win32-x64" ;;
    win32-arm64) codex_native_package="codex-win32-arm64" ;;
  esac
  anthropic_native_package="claude-agent-sdk-$native_platform"
  if [[ -f "$INSTALL_ROOT/package-lock.json" ]] \
    && cmp -s "$STAGE_ROOT/package-lock.json" "$INSTALL_ROOT/package-lock.json" \
    && [[ -f "$INSTALL_ROOT/node_modules/@openai/codex-sdk/dist/index.js" ]] \
    && [[ -x "$INSTALL_ROOT/node_modules/.bin/codex" ]] \
    && [[ -n "$codex_native_package" ]] \
    && [[ -d "$INSTALL_ROOT/node_modules/@openai/$codex_native_package" ]] \
    && [[ -f "$INSTALL_ROOT/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs" ]] \
    && [[ -d "$INSTALL_ROOT/node_modules/@anthropic-ai/$anthropic_native_package" ]]; then
    printf '[3/7] Reusing the already verified pinned Codex and Claude Agent SDK runtime\n'
    cp -a "$INSTALL_ROOT/node_modules" "$STAGE_ROOT/node_modules"
    dependencies_reused=1
  fi
  if [[ "$dependencies_reused" == "0" ]]; then
    printf '[3/7] Downloading the pinned Codex and Claude Agent SDK runtime (first install only)\n'
    (cd "$STAGE_ROOT" && npm ci \
      --omit=dev \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --fetch-retries=3 \
      --fetch-retry-mintimeout=1000 \
      --fetch-retry-maxtimeout=10000 \
      --fetch-timeout=30000)
  fi
else
  printf '[3/7] OpenRouter/xAI-only setup needs no dependency download\n'
fi

if [[ "$ENABLED_PROVIDERS" == *anthropic* ]]; then
  claude_platform="$(node -p 'process.platform + "-" + process.arch')"
  claude_libc="$(node -p '(process.report.getReport().header.glibcVersionRuntime ? "" : "-musl")')"
  claude_cli=""
  for claude_candidate in \
    "$STAGE_ROOT/node_modules/@anthropic-ai/claude-agent-sdk-${claude_platform}${claude_libc}/claude" \
    "$STAGE_ROOT"/node_modules/@anthropic-ai/claude-agent-sdk-*/claude; do
    if [[ -x "$claude_candidate" ]] && "$claude_candidate" --version >/dev/null 2>&1; then
      claude_cli="$claude_candidate"
      break
    fi
  done
  if [[ -z "$claude_cli" ]]; then
    printf '[3/7] WARNING: no runnable Claude Agent SDK binary for %s%s. Anthropic sign-in will report this; other providers are unaffected.\n' \
      "$claude_platform" "$claude_libc"
  else
    printf '[3/7] Verified the Claude Agent SDK binary for %s%s\n' "$claude_platform" "$claude_libc"
  fi
  ROUTER_CONFIG_PATH="$STAGE_ROOT/provider.json" \
  ROUTER_CLAUDE_CLI="${claude_cli/#$STAGE_ROOT/$INSTALL_ROOT}" \
  python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["ROUTER_CONFIG_PATH"])
config = json.loads(path.read_text())
value = os.environ["ROUTER_CLAUDE_CLI"]
if value:
    config["anthropicExecutablePath"] = value
else:
    config.pop("anthropicExecutablePath", None)
path.write_text(json.dumps(config, indent=2) + "\n")
path.chmod(0o600)
PY
fi

python3 - "$INSTALL_ROOT" "$STAGE_ROOT" <<'PYSTATE'
from pathlib import Path
import shutil, sys
source, destination = map(Path, sys.argv[1:])
for name in ("conversation-states.json", "audit.jsonl", "audit.jsonl.1", "chat-token"):
    existing = source / name
    if existing.is_file():
        shutil.copy2(existing, destination / name)
for name in ("conversation-states", "chats", "tailscale"):
    existing = source / name
    if existing.is_dir():
        shutil.copytree(existing, destination / name,
                        ignore=shutil.ignore_patterns("*.lock", "*.tmp", "*.sock"))
PYSTATE

emit_phase "ACTIVATE_RUNTIME"
printf '[4/7] Activating runtime atomically\n'
if [[ "$MANAGE_LEGACY" == "1" ]]; then
  # A legacy adapter install may still run its watchdog, which re-patches the
  # host whenever it changes. Delegation mode leaves the host alone, so the
  # watchdog must not outlive the runtime it belonged to.
  legacy_pid_file="$INSTALL_PARENT/grokbot-router-watchdog.pid"
  if [[ -f "$legacy_pid_file" ]]; then
    legacy_pid="$(cat "$legacy_pid_file" 2>/dev/null || true)"
    if [[ "$legacy_pid" =~ ^[0-9]+$ ]]; then
      kill "$legacy_pid" >/dev/null 2>&1 || true
    fi
    rm -f "$legacy_pid_file"
    printf 'Stopped the legacy host-adapter watchdog.\n'
  fi
  rm -f /home/box/.config/autostart/grokbot-router-watchdog.desktop
  rmdir "$INSTALL_PARENT/grokbot-router-watchdog.lock" >/dev/null 2>&1 || true
  if [[ -f "$INSTALL_PARENT/grokbot-router-backup/host-main.cjs.stock" ]]; then
    printf 'NOTE: a legacy host-adapter backup exists under %s/grokbot-router-backup. Delegation mode never touches the host; see docs/DELEGATION-MODE.md if the host is still patched.\n' "$INSTALL_PARENT"
  fi
fi
if [[ -e "$INSTALL_ROOT" ]]; then
  PREVIOUS_ROOT="${INSTALL_ROOT}.previous.$(date +%s)"
  mv "$INSTALL_ROOT" "$PREVIOUS_ROOT"
fi
mv "$STAGE_ROOT" "$INSTALL_ROOT"
STAGE_ROOT=""

rollback_runtime() {
  if [[ -d "$INSTALL_ROOT" ]]; then
    rm -rf "$INSTALL_ROOT"
  fi
  if [[ -n "$PREVIOUS_ROOT" && -d "$PREVIOUS_ROOT" ]]; then
    mv "$PREVIOUS_ROOT" "$INSTALL_ROOT"
  fi
}

emit_phase "REGISTER_COMMANDS"
printf '[5/7] Registering native commands\n'
# Link to the physical install path: grokbot-router resolves its own location
# with cd -P and compares link targets against it when reporting or removing them.
INSTALL_ROOT_PHYSICAL="$(cd -P "$INSTALL_ROOT" && pwd -P)"
mkdir -p "$GROK_SKILLS_ROOT"
for skill_name in $SKILL_NAMES; do
  skill_source="$INSTALL_ROOT_PHYSICAL/skills/$skill_name"
  skill_link="$GROK_SKILLS_ROOT/$skill_name"
  if [[ -L "$skill_link" ]]; then
    ln -sfn "$skill_source" "$skill_link"
  elif [[ -e "$skill_link" ]]; then
    printf 'WARNING: %s already exists and is not a GrokRouter link; /%s keeps the existing definition\n' "$skill_link" "$skill_name" >&2
  else
    ln -s "$skill_source" "$skill_link"
  fi
done

ROUTER_BIN_DIR="${ROUTER_BIN_DIR:-/home/box/.local/bin}"
mkdir -p "$ROUTER_BIN_DIR"
ln -sfn "$INSTALL_ROOT_PHYSICAL/bin/grokbot-router" "$ROUTER_BIN_DIR/grokbot-router"
if [[ "$ROUTER_BIN_DIR" == "/home/box/.local/bin" ]]; then
  if [[ -w "/usr/local/bin" ]]; then
    ln -sfn "$INSTALL_ROOT_PHYSICAL/bin/grokbot-router" "/usr/local/bin/grokbot-router"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n ln -sfn "$INSTALL_ROOT_PHYSICAL/bin/grokbot-router" "/usr/local/bin/grokbot-router"
  else
    printf 'WARNING: use /home/box/.local/bin/grokbot-router because /usr/local/bin is not writable\n' >&2
  fi
fi

emit_phase "VERIFY_INSTALL"
printf '[6/7] Final verification\n'
if ! node --check "$INSTALL_ROOT/run-provider.mjs" || ! node --check "$INSTALL_ROOT/delegate.mjs" || ! node --check "$INSTALL_ROOT/serve.mjs" || ! node --check "$INSTALL_ROOT/tailnet.mjs"; then
  rollback_runtime
  fail_install "RUNTIME_SYNTAX" "the installed runtime does not parse; the previous runtime was restored"
fi
if ! BOT_STATUS="$("$INSTALL_ROOT/bin/grokbot-router" bot 2>&1)"; then
  printf '%s\n' "$BOT_STATUS" >&2
  rollback_runtime
  fail_install "RUNNER_UNUSABLE" "the delegation runner could not read this Bot's configuration; the previous runtime was restored"
fi
printf 'This Bot: %s\n' "$BOT_STATUS"

# The zero-Grok chat UI: served by this runtime on 127.0.0.1, reachable from
# the Bot computer's own browser (or a tunnel), and restarted with the desktop.
CHAT_URL=""
if [[ "$START_CHAT" == "1" ]]; then
  if ROUTER_CHAT_PORT="$CHAT_PORT" "$INSTALL_ROOT/bin/grokbot-router" serve --daemon >"$INSTALL_PARENT/.grokbot-router-chat-start.log" 2>&1; then
    CHAT_URL="$(ROUTER_CHAT_PORT="$CHAT_PORT" "$INSTALL_ROOT/bin/grokbot-router" serve --url)"
    if [[ "$MANAGE_LEGACY" == "1" ]]; then
      mkdir -p "$(dirname "$CHAT_AUTOSTART")"
      cat > "$CHAT_AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=GrokRouter Chat
Exec=$INSTALL_ROOT/bin/grokbot-router serve --daemon
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
    fi
  else
    printf 'WARNING: the chat UI did not start; run grokbot-router serve --daemon after fixing the reason below\n' >&2
    cat "$INSTALL_PARENT/.grokbot-router-chat-start.log" >&2 || true
  fi
  rm -f "$INSTALL_PARENT/.grokbot-router-chat-start.log"
fi

ROUTER_INSTALL_ROOT="$INSTALL_ROOT" python3 - <<'PY'
import os
import shutil
from pathlib import Path

install_root = Path(os.environ["ROUTER_INSTALL_ROOT"])
backups = sorted(
    install_root.parent.glob(f"{install_root.name}.previous.*"),
    key=lambda candidate: candidate.stat().st_mtime_ns,
    reverse=True,
)
for stale in backups[2:]:
    if stale.is_dir():
        shutil.rmtree(stale)
PY

emit_phase "COMPLETE"
printf '[7/7] Done\n'
printf '\nGROKBOT_ROUTER_INSTALL_OK\n'
printf 'Version: %s\n' "$ROUTER_VERSION"
printf 'Mode: delegation (Grok Bot %s; the host is not patched)\n' "${GROK_VERSION:-${MINIMUM_GROK_VERSION}+}"
printf 'Default provider: %s\n' "$DEFAULT_PROVIDER"
printf 'Enabled providers: %s\n' "$ENABLED_PROVIDERS"
if [[ "$ENABLED_PROVIDERS" == *codex* ]]; then
  printf 'Next: run grokbot-router auth codex, then complete the device sign-in.\n'
fi
if [[ "$ENABLED_PROVIDERS" == *anthropic* ]]; then
  printf 'Next: run grokbot-router auth anthropic, then complete the Claude sign-in.\n'
fi
if [[ "$ENABLED_PROVIDERS" == *xai* ]]; then
  printf 'Next: run grokbot-router auth xai, then complete the Grok subscription sign-in.\n'
fi
if [[ "$ENABLED_PROVIDERS" == *openrouter* ]]; then
  printf 'OpenRouter uses the OPENROUTER_API_KEY saved through Grok Bot Secrets.\n'
fi
if [[ -n "$CHAT_URL" ]]; then
  printf 'Zero-Grok chat: open %s in this Bot computer'"'"'s browser (grokbot-router chat prints it again).\n' "$CHAT_URL"
  printf 'To reach it and the MCP endpoint (%s) from your other devices: grokbot-router tailscale up\n' "${CHAT_URL%%/?token=*}/mcp"
fi
printf 'Then, in the Terminal of the Mac or PC that runs Grok Bot, register the slash commands:\n'
printf '  curl -fsSL https://raw.githubusercontent.com/swcstudiospace/grokrouter/main/scripts/register-commands.sh | bash\n'
printf 'In Grok Bot chat: /router doctor to check health, then /route <task> to delegate.\n'
