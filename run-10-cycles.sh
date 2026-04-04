#!/usr/bin/env bash
# ================================
# NeuroPilot — 10 runs contrôlés (pipeline + dashboard + snapshot)
# ================================
# Usage (depuis ce répertoire) :
#   export NEUROPILOT_DATA_ROOT=/chemin/vers/data   # recommandé
#   ./run-10-cycles.sh
#
# Chaque itération : runFullPipelineExpanded.sh → buildGovernanceDashboard → status + jq paper/learning.
# Délai entre runs pour limiter la charge CPU (modifiable).

set -euo pipefail

RUNS="${RUNS:-10}"
SLEEP_SECONDS="${SLEEP_SECONDS:-60}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "[ERROR] node not found in PATH"
  exit 1
fi

# Data root — CRITIQUE : même chemin que paper exec + pipeline (sinon validTradeCount=0 dans le dashboard).
# Ordre : NEUROPILOT_DATA_ROOT si défini → sinon volume externe s’il est monté → sinon data_workspace local.
if [[ -n "${NEUROPILOT_DATA_ROOT:-}" ]]; then
  DATA_ROOT="$NEUROPILOT_DATA_ROOT"
elif [[ -d "/Volumes/TradingDrive/NeuroPilotAI" ]]; then
  DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"
  echo "[INFO] NEUROPILOT_DATA_ROOT unset → using mounted: $DATA_ROOT"
else
  DATA_ROOT="$SCRIPT_DIR/data_workspace"
  echo "[INFO] NEUROPILOT_DATA_ROOT unset → using local: $DATA_ROOT"
fi
export NEUROPILOT_DATA_ROOT="$DATA_ROOT"

if [[ ! -d "$NEUROPILOT_DATA_ROOT" ]]; then
  echo "[ERROR] NEUROPILOT_DATA_ROOT is not a directory: $NEUROPILOT_DATA_ROOT"
  exit 1
fi

echo "========================================"
echo "NeuroPilot — $RUNS runs (expanded pipeline + P8 dashboard)"
echo "NEUROPILOT_DATA_ROOT=$NEUROPILOT_DATA_ROOT"
echo "SLEEP_SECONDS=$SLEEP_SECONDS"
echo "========================================"

for ((i = 1; i <= RUNS; i++)); do
  echo ""
  echo "==============================="
  echo "RUN $i / $RUNS"
  echo "==============================="

  START_TIME="$(date +"%Y-%m-%d %H:%M:%S")"

  bash "$SCRIPT_DIR/engine/scripts/runFullPipelineExpanded.sh"

  "$NODE_BIN" "$SCRIPT_DIR/engine/governance/buildGovernanceDashboard.js"

  echo ""
  echo "---- STATUS SNAPSHOT ----"
  "$SCRIPT_DIR/status-system.sh"

  echo ""
  echo "---- PAPER METRICS (global V1) ----"
  if [[ -f "$SCRIPT_DIR/ops-snapshot/governance_dashboard.json" ]]; then
    jq '{validTradeCount: .paperTradesMetrics.validTradeCount, winRate: .paperTradesMetrics.winRate, totalPnl: .paperTradesMetrics.totalPnl, parseErrors: .paperTradesMetrics.parseErrors}' \
      "$SCRIPT_DIR/ops-snapshot/governance_dashboard.json" || true
  else
    echo "No governance_dashboard.json — run buildGovernanceDashboard"
  fi

  echo ""
  echo "---- LEARNING SNAPSHOT (V1 suggestive) ----"
  if [[ -f "$SCRIPT_DIR/ops-snapshot/governance_dashboard.json" ]]; then
    jq '{confidence: .paperLearningInsights.confidence, best: .paperLearningInsights.summaryBestStrategyId, worst: .paperLearningInsights.summaryWorstStrategyId}' \
      "$SCRIPT_DIR/ops-snapshot/governance_dashboard.json" || true
  else
    echo "No governance_dashboard.json"
  fi

  END_TIME="$(date +"%Y-%m-%d %H:%M:%S")"

  echo ""
  echo "Run $i completed"
  echo "Start: $START_TIME"
  echo "End:   $END_TIME"

  if [[ "$i" -lt "$RUNS" ]]; then
    echo "Sleeping ${SLEEP_SECONDS}s before next run..."
    sleep "$SLEEP_SECONDS"
  fi
done

echo ""
echo "========================================"
echo "All $RUNS runs completed"
echo "========================================"
