#!/bin/bash
# Serves Sobremesa from this Mac until it moves to Cloudflare Pages: the
# web server, the sync that rebuilds after each save in the admin, and the
# tunnel to sobremesa.quique.info, as launchd agents that start at login.
# Safe to run again after changes.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS" "$HOME/.local/share/sobremesa/logs"
"$DIR/sync.sh"
for plist in "$DIR"/*.plist; do
  label="$(basename "$plist" .plist)"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  cp "$plist" "$AGENTS/"
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
  echo "loaded $label"
done
