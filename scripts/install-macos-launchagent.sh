#!/bin/bash
# Registers the Mero Restro Print Agent as a per-user LaunchAgent so it
# starts automatically at login. Run AFTER `npm run package:mac` has
# produced dist-pkg/mero-restro-print-agent-macos (or after building for
# your Mac's own architecture):
#
#   chmod +x scripts/install-macos-launchagent.sh
#   ./scripts/install-macos-launchagent.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
EXECUTABLE="$AGENT_DIR/dist-pkg/mero-restro-print-agent-macos"
LOG_DIR="$HOME/Library/Application Support/MeroRestroPrintAgent"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_DEST="$LAUNCH_AGENTS_DIR/com.merorestro.printagent.plist"

if [ ! -f "$EXECUTABLE" ]; then
  echo "Could not find $EXECUTABLE — run 'npm run package:mac' first." >&2
  exit 1
fi
chmod +x "$EXECUTABLE"

mkdir -p "$LOG_DIR" "$LAUNCH_AGENTS_DIR"

sed \
  -e "s#__EXECUTABLE_PATH__#$EXECUTABLE#g" \
  -e "s#__LOG_DIR__#$LOG_DIR#g" \
  "$SCRIPT_DIR/com.merorestro.printagent.plist" > "$PLIST_DEST"

# Unload first in case this is a reinstall/update.
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "Installed and started. The Print Agent will now start automatically at login."
echo "Logs: $LOG_DIR"
echo "To stop it:    launchctl unload \"$PLIST_DEST\""
echo "To start it:   launchctl load \"$PLIST_DEST\""
