#!/usr/bin/env bash
set -u

ROOT="/Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2"
DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"
LOG_DIR="$DATA_ROOT/logs"
LOCK_FILE="/tmp/neuropilot_paper_loop.lock"

mkdir -p "$LOG_DIR"

if [ -f "$LOCK_FILE" ]; then
  echo "[paper_loop] lock exists: $LOCK_FILE"
  exit 1
fi

trap 'rm -f "$LOCK_FILE"' EXIT
echo $$ > "$LOCK_FILE"

export NEUROPILOT_DATA_ROOT="$DATA_ROOT"
export NEUROPILOT_WAVE1_SYMBOLS="${NEUROPILOT_WAVE1_SYMBOLS:-BTCUSDT,SPY,XRPUSDT}"

cd "$ROOT" || exit 1

while true; do
  TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "[paper_loop] cycle_start $TS" | tee -a "$LOG_DIR/paper_loop.log"

  npm run paper:refresh-chain >> "$LOG_DIR/paper_loop.log" 2>&1
  CHAIN_EXIT=$?

  node engine/evolution/scripts/exportOpsSnapshot.js >> "$LOG_DIR/paper_loop.log" 2>&1
  SNAP_EXIT=$?

  echo "[paper_loop] cycle_end $TS chain_exit=$CHAIN_EXIT snapshot_exit=$SNAP_EXIT" | tee -a "$LOG_DIR/paper_loop.log"

  sleep 300
done
