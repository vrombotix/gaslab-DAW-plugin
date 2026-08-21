#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/integrations/ardour/ai_daw_import_bridge.lua"
for DIR in "$HOME/.config/ardour8/scripts" "$HOME/.config/ardour9/scripts"; do
  mkdir -p "$DIR"
  cp "$SCRIPT" "$DIR/ai_daw_import_bridge.lua"
  echo "Installed: $DIR/ai_daw_import_bridge.lua"
done
cat <<'TXT'

Next in Ardour:
1. Open/create a session.
2. Edit -> Scripted Actions -> Manage.
3. Enable "AI DAW Import Bridge" as an Editor Hook / Callback.
4. Keep that session open.
TXT
