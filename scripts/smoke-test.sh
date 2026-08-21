#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

cmake -S . -B build
cmake --build build -j

node mock-api/src/server.mjs >/tmp/ai-daw-prototype-mock-api.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
sleep 0.5

echo "== Agent health =="
./build/daw-agent health
echo

echo "== DAW discovery =="
./build/daw-agent daws
echo

echo "== Fake generation + downloads =="
./build/daw-agent generate --prompt "smoke test generation"
echo

echo "PASS: mock API -> C++ agent -> WAV downloads"
