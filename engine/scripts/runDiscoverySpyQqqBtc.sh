#!/usr/bin/env bash
# Run: convert CSV → .bin, then two-stage discovery for SPY 5m, QQQ 5m, BTCUSDT 5m.
# Requires: real CSV files in place (see README_DATASETS.md).
# Usage: from neuropilot_trading_v2: NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI ./engine/scripts/runDiscoverySpyQqqBtc.sh

set -e
ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
ENGINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$(cd "$ENGINE_DIR/.." && pwd)"
cd "$PROJECT_DIR"

export NEUROPILOT_DATA_ROOT="$ROOT"

run_one() {
  local symbol="$1"
  local tf="$2"
  local data_group="$3"
  local csv_path="$ROOT/datasets/$4/${4}_${tf}.csv"
  if [[ ! -f "$csv_path" ]]; then
    echo "Skip $symbol $tf: CSV not found at $csv_path"
    return 0
  fi
  echo "--- $symbol $tf ($data_group) ---"
  node engine/scripts/csvToBinary.js "$csv_path" "$symbol" "$tf"
  node engine/discovery/runTwoStageDiscovery.js "$symbol" "$tf" "$data_group"
}

echo "Data root: $NEUROPILOT_DATA_ROOT"
mkdir -p "$ROOT/datasets/spy" "$ROOT/datasets/qqq" "$ROOT/datasets/btcusdt" "$ROOT/datasets/xauusd"

run_one SPY  5m spy_5m     spy
run_one QQQ  5m qqq_5m     qqq
run_one BTCUSDT 5m btcusdt_5m btcusdt
run_one XAUUSD 5m xauusd_5m xauusd
run_one XAUUSD 1h xauusd_1h xauusd

echo "Done: SPY, QQQ, BTCUSDT, XAUUSD (convert + two-stage)."
