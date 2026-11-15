#!/usr/bin/env bash
# Installs the SoundCloud DL native messaging host for all detected Chromium browsers on macOS
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/index.js"
WRAPPER_SCRIPT="$SCRIPT_DIR/run.sh"
HOST_NAME="com.soundclouddl.host"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SoundCloud DL — Native Host Installer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Check dependencies ──────────────────────────────

MISSING=0
check_dep() {
  if ! command -v "$1" &>/dev/null; then
    echo "✗ $1 not found  →  $2"
    MISSING=1
  else
    echo "✓ $1  ($(command -v "$1"))"
  fi
}
check_dep node   "https://nodejs.org"
check_dep yt-dlp "brew install yt-dlp"
check_dep ffmpeg "brew install ffmpeg"
echo ""
if [[ "$MISSING" -eq 1 ]]; then
  echo "Install missing dependencies and re-run."
  exit 1
fi

# Resolve absolute node path now (while PATH is set correctly from the shell).
# GUI apps like Dia launch subprocesses with a stripped PATH (/usr/bin:/bin only),
# so the wrapper script hard-codes the absolute path found here.
NODE_BIN="$(command -v node)"

# ── Collect extension IDs ───────────────────────────
# Pass IDs as arguments, or set EXTENSION_IDS env var, or enter interactively.

EXT_IDS_STR=""

if [[ "${#}" -gt 0 ]]; then
  EXT_IDS_STR="$*"
elif [[ -n "${EXTENSION_IDS:-}" ]]; then
  EXT_IDS_STR="$EXTENSION_IDS"
else
  echo "Enter one or more extension IDs (space-separated)."
  echo "Find them at  dia://extensions  or  chrome://extensions"
  echo "after loading the unpacked build from extension/.output/chrome-mv3/"
  echo ""
  read -r -p "Extension ID(s): " EXT_IDS_STR
fi

if [[ -z "$EXT_IDS_STR" ]]; then
  echo "No extension IDs provided. Aborting."
  exit 1
fi

echo ""
echo "Using IDs: $EXT_IDS_STR"
echo ""

# Build JSON allowed_origins array
ORIGINS_JSON=""
for ID in $EXT_IDS_STR; do
  [[ -n "$ORIGINS_JSON" ]] && ORIGINS_JSON+=","
  ORIGINS_JSON+="\"chrome-extension://${ID}/\""
done

# ── Create wrapper script ────────────────────────────
# The wrapper uses the absolute node path so it works when launched by a
# browser whose PATH doesn't include NVM / Homebrew / pyenv-managed binaries.

cat > "$WRAPPER_SCRIPT" <<EOF
#!/bin/bash
# Extend PATH so yt-dlp/ffmpeg (Homebrew, nvm, etc.) are reachable when
# the browser launches this with a stripped system PATH.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:\$PATH"
exec "$NODE_BIN" "$HOST_SCRIPT"
EOF
chmod +x "$WRAPPER_SCRIPT"
echo "✓ Wrapper  →  $WRAPPER_SCRIPT  (node: $NODE_BIN)"
echo ""

# ── Write manifest to a directory ──────────────────

write_manifest() {
  local NMH_DIR="$1"
  mkdir -p "$NMH_DIR"
  cat > "$NMH_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "SoundCloud DL native messaging host",
  "path": "$WRAPPER_SCRIPT",
  "type": "stdio",
  "allowed_origins": [$ORIGINS_JSON]
}
EOF
}

# ── Detect and install for each browser ────────────
# Format: "BrowserName|NativeMessagingHosts path|parent dir to check for existence"

BROWSER_CONFIGS="
Chrome|$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts|$HOME/Library/Application Support/Google/Chrome
Chromium|$HOME/Library/Application Support/Chromium/NativeMessagingHosts|$HOME/Library/Application Support/Chromium
Brave|$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts|$HOME/Library/Application Support/BraveSoftware
Edge|$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts|$HOME/Library/Application Support/Microsoft Edge
Arc|$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts|$HOME/Library/Application Support/Arc
Dia|$HOME/Library/Application Support/Dia/User Data/NativeMessagingHosts|$HOME/Library/Application Support/Dia
"

INSTALLED=0

while IFS='|' read -r BROWSER NMH_DIR PARENT_DIR; do
  [[ -z "$BROWSER" ]] && continue
  [[ ! -d "$PARENT_DIR" ]] && continue

  write_manifest "$NMH_DIR"
  echo "✓ $BROWSER  →  $NMH_DIR/$HOST_NAME.json"
  INSTALLED=$((INSTALLED + 1))
done <<< "$BROWSER_CONFIGS"

if [[ "$INSTALLED" -eq 0 ]]; then
  echo "No supported Chromium browsers found."
  echo "Run manually with the path to your browser's NativeMessagingHosts directory."
  exit 1
fi

# ── Make host script executable ─────────────────────

chmod +x "$HOST_SCRIPT"

echo ""
echo "✓ Host:    $HOST_SCRIPT"
echo "✓ Wrapper: $WRAPPER_SCRIPT  (node: $NODE_BIN)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Done — registered for $INSTALLED browser(s)"
echo ""
echo "  Reload the extension, then test a download."
echo "  To add another browser later:"
echo "  bash install.sh <extension-id-in-that-browser>"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
