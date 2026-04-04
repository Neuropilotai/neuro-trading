#!/usr/bin/env bash
# NeuroPilot — start evolution loop + local dashboard HTTP server.
# Usage: ./start-system.sh
# Optional: export NEUROPILOT_DATA_ROOT=/path/to/data before running.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Default data root (override with env). Example external drive:
export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"

DASHBOARD_PORT="${DASHBOARD_PORT:-8080}"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

echo "[start-system] DATA_ROOT=$NEUROPILOT_DATA_ROOT"
echo "[start-system] Project root=$SCRIPT_DIR"

# Stop stale instances (same patterns as stop-system.sh)
pkill -f "runFullPipelineExpanded\.sh" 2>/dev/null || true
pkill -f "runMetaPipeline\.js" 2>/dev/null || true
pkill -f "run-smart-evolution-loop\.sh" 2>/dev/null || true
pkill -f "caffeinate -dims ./run-smart-evolution-loop\.sh" 2>/dev/null || true
pkill -f "python3 -m http\.server ${DASHBOARD_PORT}" 2>/dev/null || true
sleep 1

# Evolution loop (macOS: keep awake while loop runs)
if ! command -v caffeinate >/dev/null 2>&1; then
  echo "[start-system] WARN: caffeinate not found; starting loop without it."
  nohup ./run-smart-evolution-loop.sh >>"$LOG_DIR/evolution-loop.log" 2>&1 &
else
  nohup caffeinate -dims ./run-smart-evolution-loop.sh >>"$LOG_DIR/evolution-loop.log" 2>&1 &
fi
echo $! >"$LOG_DIR/neuropilot-loop.pid"
echo "[start-system] Evolution loop started (PID $(cat "$LOG_DIR/neuropilot-loop.pid")), log: $LOG_DIR/evolution-loop.log"

# Dashboard static server (serves ops-snapshot under this repo)
nohup python3 -m http.server "$DASHBOARD_PORT" --directory "$SCRIPT_DIR" >>"$LOG_DIR/dashboard.log" 2>&1 &
echo $! >"$LOG_DIR/neuropilot-dashboard.pid"
echo "[start-system] Dashboard http://localhost:${DASHBOARD_PORT}/ops-snapshot/governance_dashboard.html (PID $(cat "$LOG_DIR/neuropilot-dashboard.pid"))"

sleep 2
if command -v open >/dev/null 2>&1; then
  open "http://localhost:${DASHBOARD_PORT}/ops-snapshot/governance_dashboard.html"
fi

echo "[start-system] Done."
