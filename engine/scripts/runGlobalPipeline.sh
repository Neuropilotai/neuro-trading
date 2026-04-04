#!/usr/bin/env bash
# Pipeline global : Data → Discovery → Meta → Evolution → Paper (reload champions).
#
# Usage:
#   NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI ./engine/scripts/runGlobalPipeline.sh
#
# Ordre :
#   1. runExpandedDataEngine — 11 actifs × 3 timeframes (5m, 15m, 1h), manifest, download, update, validate, .bin
#   2. runFullPipeline       — auto download + convert + two-stage (SPY, QQQ, BTCUSDT, XAUUSD)
#   3. runMetaPipeline      — cross-asset, multi-timeframe, meta ranking, strategy_portfolio
#   4. strategyEvolution    — meta_ranking → champion_registry.json
#   5. runPaperSession      — recharger la liste des champions

set -e
export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

echo "=== 1/5 Data Engine (expanded) ==="
node engine/data/runExpandedDataEngine.js

echo "=== 2/5 Full Pipeline (discovery) ==="
./engine/scripts/runFullPipeline.sh

echo "=== 3/5 Meta Pipeline ==="
node engine/meta/runMetaPipeline.js

echo "=== 4/5 Strategy Evolution ==="
node engine/evolution/strategyEvolution.js

echo "=== 5/5 Paper — reload champions ==="
node engine/paper/runPaperSession.js --reload-champions

echo "Done. Pipeline global terminé."
