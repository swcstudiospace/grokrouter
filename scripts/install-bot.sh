#!/usr/bin/env bash
set -euo pipefail

# One-line GrokRouter install for a Grok Bot 0.63.0+ Bot computer. Paste in the
# Bot terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/swcstudiospace/grokrouter/main/scripts/install-bot.sh | bash -s -- --provider anthropic --anthropic-model claude-opus-5-5 --reasoning xhigh
#
# Every option after `--` is passed to remote/install-delegation.sh. Set
# GROKROUTER_REF to install a tag or branch other than main, for example
# GROKROUTER_REF=source-v0.1.0-beta.48.

REPOSITORY="${GROKROUTER_REPOSITORY:-swcstudiospace/grokrouter}"
SOURCE_REF="${GROKROUTER_REF:-main}"
SOURCE_ROOT=""
TEMP_SOURCE=""

cleanup() {
  if [[ -n "$TEMP_SOURCE" && -d "$TEMP_SOURCE" ]]; then
    rm -rf "$TEMP_SOURCE"
  fi
}
trap cleanup EXIT

fail() {
  printf '\nGrokRouter could not be installed: %s\n' "$1" >&2
  exit 1
}

if [[ ! "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  fail "GROKROUTER_REPOSITORY must be owner/name"
fi
if [[ ! "$SOURCE_REF" =~ ^[A-Za-z0-9][A-Za-z0-9_./-]*$ ]]; then
  fail "GROKROUTER_REF must be a tag, branch, or commit"
fi

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" 2>/dev/null && pwd || true)"
fi
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../remote/install-delegation.sh" ]]; then
  SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  for command_name in tar; do
    command -v "$command_name" >/dev/null 2>&1 || fail "required command is missing: $command_name"
  done
  TEMP_SOURCE="$(mktemp -d -t grokrouter-source.XXXXXX)"
  ARCHIVE="$TEMP_SOURCE/grokrouter.tar.gz"
  ARCHIVE_URL="https://github.com/$REPOSITORY/archive/$SOURCE_REF.tar.gz"
  printf 'Downloading GrokRouter %s from GitHub...\n' "$SOURCE_REF"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location "$ARCHIVE_URL" --output "$ARCHIVE"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --output-document="$ARCHIVE" "$ARCHIVE_URL"
  else
    fail "curl or wget is required to download GrokRouter"
  fi
  mkdir -p "$TEMP_SOURCE/source"
  tar -xzf "$ARCHIVE" -C "$TEMP_SOURCE/source"
  SOURCE_ROOT="$(find "$TEMP_SOURCE/source" -mindepth 1 -maxdepth 1 -type d -print -quit)"
fi

[[ -n "$SOURCE_ROOT" && -f "$SOURCE_ROOT/remote/install-delegation.sh" ]] \
  || fail "the source archive is missing remote/install-delegation.sh (GrokRouter $SOURCE_REF predates delegation mode)"

printf 'Installing GrokRouter delegation mode from %s@%s\n' "$REPOSITORY" "$SOURCE_REF"
GROKROUTER_INSTALL_SOURCE="$REPOSITORY@$SOURCE_REF" bash "$SOURCE_ROOT/remote/install-delegation.sh" "$@"
