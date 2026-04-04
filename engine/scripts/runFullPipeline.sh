#!/usr/bin/env bash
# Full autonomous pipeline: dataset check → auto download → CSV→binary → two-stage discovery.
# Usage: NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI ./engine/scripts/runFullPipeline.sh

set -e
export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

echo "1. Dataset check + auto download"
node engine/scripts/autoDownloadDatasets.js

echo "2. Convert to binary + two-stage discovery (SPY, QQQ, BTCUSDT 5m)"
./engine/scripts/runDiscoverySpyQqqBtc.sh

echo "Done. Results: $NEUROPILOT_DATA_ROOT/batch_results/strategy_batch_results.json"
