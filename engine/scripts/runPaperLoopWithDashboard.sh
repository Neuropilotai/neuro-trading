#!/usr/bin/env bash
# Continuous loop: npm run paper:refresh-chain → buildGovernanceDashboard.js
# Logs: $NEUROPILOT_DATA_ROOT/logs/paper_loop_dashboard.log
# Lock: /tmp/neuropilot_paper_loop_dashboard.lock (single instance)
# Env: NEUROPILOT_DATA_ROOT (required), NEUROPILOT_PAPER_LOOP_INTERVAL_SEC (default 300), optional NEUROPILOT_WAVE1_SYMBOLS / cycle ids (passed through).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCK_FILE="/tmp/neuropilot_paper_loop_dashboard.lock"

if [[ -z "${NEUROPILOT_DATA_ROOT:-}" ]]; then
  echo "[paper_loop_dashboard] FATAL: set NEUROPILOT_DATA_ROOT" >&2
  exit 1
fi
if [[ ! -d "$NEUROPILOT_DATA_ROOT" ]]; then
  echo "[paper_loop_dashboard] FATAL: NEUROPILOT_DATA_ROOT is not a directory: $NEUROPILOT_DATA_ROOT" >&2
  exit 1
fi

LOG_DIR="$NEUROPILOT_DATA_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/paper_loop_dashboard.log"

if [[ -f "$LOCK_FILE" ]]; then
  echo "[paper_loop_dashboard] another instance holds lock: $LOCK_FILE" >&2
  exit 1
fi

cleanup_lock() {
  rm -f "$LOCK_FILE"
}
trap cleanup_lock EXIT INT TERM
echo $$ > "$LOCK_FILE"

INTERVAL_SEC="${NEUROPILOT_PAPER_LOOP_INTERVAL_SEC:-300}"
cd "$REPO_ROOT" || exit 1

echo "[paper_loop_dashboard] start pid=$$ repo=$REPO_ROOT data_root=$NEUROPILOT_DATA_ROOT interval_sec=$INTERVAL_SEC" | tee -a "$LOG_FILE"

while true; do
  CYCLE_START="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "[paper_loop_dashboard] cycle_start $CYCLE_START" | tee -a "$LOG_FILE"

  npm run paper:refresh-chain >>"$LOG_FILE" 2>&1
  CHAIN_EXIT=$?

  node engine/governance/buildGovernanceDashboard.js >>"$LOG_FILE" 2>&1
  DASH_EXIT=$?

  CYCLE_END="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "[paper_loop_dashboard] cycle_end $CYCLE_END chain_exit=$CHAIN_EXIT dashboard_exit=$DASH_EXIT" | tee -a "$LOG_FILE"

  sleep "$INTERVAL_SEC"
done
