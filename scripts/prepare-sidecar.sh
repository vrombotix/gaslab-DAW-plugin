#!/usr/bin/env bash
# Copies the built daw-agent to where Tauri expects its sidecar:
# apps/desktop/src-tauri/binaries/daw-agent-<target-triple>[.exe]
# Usage: scripts/prepare-sidecar.sh [target-triple]   (default: rustc's host triple)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/apps/desktop/src-tauri/binaries"

TRIPLE="${1:-$(rustc -vV | awk '/^host:/ { print $2 }')}"
if [ -z "$TRIPLE" ]; then
  echo "error: could not determine Rust target triple (is rustc on PATH?)" >&2
  exit 1
fi
EXT=""
[[ "$TRIPLE" == *windows* ]] && EXT=".exe"

# Multi-config generators (Visual Studio) put the binary in build/Release.
AGENT=""
for candidate in "$ROOT/build/daw-agent$EXT" "$ROOT/build/Release/daw-agent$EXT"; do
  if [ -f "$candidate" ]; then AGENT="$candidate"; break; fi
done
if [ -z "$AGENT" ]; then
  echo "error: daw-agent$EXT not found under build/. Build it first:" >&2
  echo "  cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
DEST="$BIN_DIR/daw-agent-$TRIPLE$EXT"
cp "$AGENT" "$DEST"
chmod +x "$DEST"
echo "Installed sidecar: $DEST"
