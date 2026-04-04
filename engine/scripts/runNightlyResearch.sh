#!/usr/bin/env bash
set -euo pipefail

# ==========================================
# NeuroPilot Nightly Research
# ==========================================
# Pipeline:
# 1. Data Engine
# 2. Full discovery pipeline
# 3. Meta ranking + portfolio
# 4. Strategy evolution
# 5. Paper session reload champions
#
# Usage:
#   export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
#   export NEUROPILOT_GDRIVE_BACKUP_ROOT="$HOME/Library/CloudStorage/GoogleDrive-neuro.pilot.ai@gmail.com/My Drive/Neuro.Pilot.AI/backups"
#   ./engine/scripts/runNightlyResearch.sh
#
# Optional env:
#   TOP_N=30
#   PORTFOLIO_MAX=12
#   ENABLE_GDRIVE_BACKUP=1
# ==========================================

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "[ERROR] node not found in PATH"
  exit 1
fi

DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
GDRIVE_ROOT="${NEUROPILOT_GDRIVE_BACKUP_ROOT:-}"
TOP_N="${TOP_N:-30}"
PORTFOLIO_MAX="${PORTFOLIO_MAX:-12}"
ENABLE_GDRIVE_BACKUP="${ENABLE_GDRIVE_BACKUP:-0}"

if [[ ! -d "$DATA_ROOT" ]]; then
  echo "[ERROR] DATA_ROOT not found: $DATA_ROOT"
  exit 1
fi

mkdir -p "$DATA_ROOT"/{datasets,features,generated_strategies,batch_results,bootstrap,discovery,brain_snapshots,champion_setups,evolution_runs,paper,nightly_logs,archives}

TS="$(date +%Y%m%d_%H%M%S)"
LOCAL_LOG_DIR="$PROJECT_ROOT/nightly_logs"
mkdir -p "$LOCAL_LOG_DIR"
LOG_FILE="$LOCAL_LOG_DIR/nightly_research_${TS}.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "======================================"
echo "NeuroPilot Nightly Research started: $TS"
echo "PROJECT_ROOT=$PROJECT_ROOT"
echo "DATA_ROOT=$DATA_ROOT"
echo "GDRIVE_ROOT=$GDRIVE_ROOT"
echo "NODE_BIN=$NODE_BIN"
echo "TOP_N=$TOP_N"
echo "PORTFOLIO_MAX=$PORTFOLIO_MAX"
echo "======================================"
echo

echo "[1/6] Data Engine (expanded)"
export NEUROPILOT_DATA_ROOT="$DATA_ROOT"
"$NODE_BIN" engine/data/runExpandedDataEngine.js
echo

echo "[2/6] Full Discovery Pipeline"
./engine/scripts/runFullPipeline.sh
echo

echo "[3/6] Meta Pipeline"
"$NODE_BIN" engine/meta/runMetaPipeline.js "$TOP_N" "$PORTFOLIO_MAX"
echo

echo "[4/6] Strategy Evolution"
"$NODE_BIN" engine/evolution/strategyEvolution.js || echo "[WARN] Strategy evolution failed"
echo

echo "[5/6] Paper Session reload champions"
"$NODE_BIN" engine/paper/runPaperSession.js --reload-champions || echo "[WARN] Paper session reload failed"
"$NODE_BIN" engine/paper/runPaperSession.js || echo "[WARN] Paper session status failed"
echo

echo "[6/6] Snapshot + optional Google Drive backup"

if [[ -f "$DATA_ROOT/discovery/meta_ranking.json" ]]; then
  cp "$DATA_ROOT/discovery/meta_ranking.json" "$DATA_ROOT/brain_snapshots/meta_ranking_${TS}.json" || echo "[WARN] Could not snapshot meta_ranking.json"
fi

if [[ -f "$DATA_ROOT/discovery/strategy_portfolio.json" ]]; then
  cp "$DATA_ROOT/discovery/strategy_portfolio.json" "$DATA_ROOT/brain_snapshots/strategy_portfolio_${TS}.json" || echo "[WARN] Could not snapshot strategy_portfolio.json"
fi

if [[ -f "$DATA_ROOT/champion_setups/champion_registry.json" ]]; then
  cp "$DATA_ROOT/champion_setups/champion_registry.json" "$DATA_ROOT/brain_snapshots/champion_registry_${TS}.json" || echo "[WARN] Could not snapshot champion_registry.json"
fi

if [[ "$ENABLE_GDRIVE_BACKUP" == "1" ]]; then
  if [[ -n "$GDRIVE_ROOT" && -d "$GDRIVE_ROOT" ]]; then
    ./scripts/backup_discovery_to_gdrive.sh --dated || echo "[WARN] Google Drive backup failed"
  else
    echo "[SKIP] Google Drive backup skipped (GDRIVE root missing)"
  fi
else
  echo "[SKIP] Google Drive backup disabled (ENABLE_GDRIVE_BACKUP=$ENABLE_GDRIVE_BACKUP)"
fi

echo
echo "NeuroPilot Nightly Research finished: $(date '+%Y-%m-%d %H:%M:%S')"
echo "Local log: $LOG_FILE"
