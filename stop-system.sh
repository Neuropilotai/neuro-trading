#!/usr/bin/env bash
# NeuroPilot — stop evolution loop + dashboard server started by start-system.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
DASHBOARD_PORT="${DASHBOARD_PORT:-8080}"

echo "[stop-system] Stopping NeuroPilot system..."

stop_pidfile() {
  local f="$1"
  if [[ -f "$f" ]]; then
    local pid
    pid="$(cat "$f" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "[stop-system] Sent SIGTERM to PID $pid ($f)"
    fi
    rm -f "$f"
  fi
}

stop_pidfile "$LOG_DIR/neuropilot-loop.pid"
stop_pidfile "$LOG_DIR/neuropilot-dashboard.pid"

# Broad cleanup (matches start-system + common child processes)
pkill -f "runFullPipelineExpanded\.sh" 2>/dev/null || true
pkill -f "runMetaPipeline\.js" 2>/dev/null || true
pkill -f "run-smart-evolution-loop\.sh" 2>/dev/null || true
pkill -f "caffeinate -dims ./run-smart-evolution-loop\.sh" 2>/dev/null || true
pkill -f "python3 -m http\.server ${DASHBOARD_PORT}" 2>/dev/null || true

sleep 1

echo "[stop-system] Remaining matches (should be empty):"
pgrep -fl "runFullPipelineExpanded\.sh|runMetaPipeline\.js|run-smart-evolution-loop\.sh|caffeinate -dims ./run-smart-evolution-loop|python3 -m http\.server ${DASHBOARD_PORT}" 2>/dev/null || echo "[stop-system] None."
echo "[stop-system] Done."
