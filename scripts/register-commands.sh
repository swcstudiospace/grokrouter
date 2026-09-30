#!/usr/bin/env bash
set -euo pipefail

# One-line registration of GrokRouter's slash commands in the Grok Bot desktop
# app (delegation mode, Grok Bot 0.63.0+). Paste in the Mac's Terminal after the
# Bot terminal install:
#
#   curl -fsSL https://raw.githubusercontent.com/swcstudiospace/grokrouter/main/scripts/register-commands.sh | bash
#
# Options after `bash -s --` go to scripts/register-native-commands.mjs
# (for example `--remove`). GROKROUTER_REF selects a tag or branch other than main.

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
  printf '\nGrokRouter commands could not be registered: %s\n' "$1" >&2
  exit 1
}

if [[ ! "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  fail "GROKROUTER_REPOSITORY must be owner/name"
fi
if [[ ! "$SOURCE_REF" =~ ^[A-Za-z0-9][A-Za-z0-9_./-]*$ ]]; then
  fail "GROKROUTER_REF must be a tag, branch, or commit"
fi
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required (https://nodejs.org)"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 )); then
  fail "Node.js 22 or newer is required; found $(node -v)"
fi

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" 2>/dev/null && pwd || true)"
fi
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/register-native-commands.mjs" ]]; then
  SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  command -v tar >/dev/null 2>&1 || fail "required command is missing: tar"
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

[[ -n "$SOURCE_ROOT" && -f "$SOURCE_ROOT/scripts/register-native-commands.mjs" ]] \
  || fail "the source archive is missing scripts/register-native-commands.mjs (GrokRouter $SOURCE_REF predates delegation mode)"

node "$SOURCE_ROOT/scripts/register-native-commands.mjs" "$@"
