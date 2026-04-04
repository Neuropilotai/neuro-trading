#!/usr/bin/env bash
#
# NeuroPilot — evolution loop (continuous, throttled).
#
# From neuropilot_trading_v2:
#   chmod +x run-evolution-loop.sh
#   ./run-evolution-loop.sh
#   nohup ./run-evolution-loop.sh > evolution.log 2>&1 &
#
# Must match engine/dataRoot.js: same NEUROPILOT_DATA_ROOT as batch/discovery.
# Example (external drive):
#   export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
#   ./run-evolution-loop.sh
#
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-$SCRIPT_DIR/data_workspace}"
DATA_ROOT="$NEUROPILOT_DATA_ROOT"
CHAMPION_DIR="${DATA_ROOT}/champion_setups"
REGISTRY="${CHAMPION_DIR}/champion_registry.json"
BACKUP_PREFIX="${CHAMPION_DIR}/backup_champion_registry_"

echo "🚀 NeuroPilot Evolution Loop Started"
echo "   NEUROPILOT_DATA_ROOT=$NEUROPILOT_DATA_ROOT"
echo "   Registry: $REGISTRY"
echo ""

while true; do
  echo "----------------------------------"
  echo "⏱ Run started at: $(date)"

  if [[ "${NEUROPILOT_OWNER_APPROVAL_GATE:-0}" == "1" ]]; then
    if ! node engine/evolution/scripts/checkOwnerApprovalAllowNextCycle.js; then
      echo "⏸ Owner approval gate: evolution run skipped (set NEUROPILOT_OWNER_APPROVAL_GATE=0 to bypass)"
      echo "💤 Sleep 60s…"
      sleep 60
      continue
    fi
  fi

  if node engine/evolution/strategyEvolution.js; then
    echo "✅ Run completed at: $(date)"
  else
    echo "⚠️ Evolution run FAILED at: $(date)"
  fi

  if [[ -f "$REGISTRY" ]]; then
    mkdir -p "$CHAMPION_DIR" || true
    if cp "$REGISTRY" "${BACKUP_PREFIX}$(date +%s).json" 2>/dev/null; then
      echo "📦 Registry backup written under champion_setups/"
    else
      echo "⚠️ Registry backup failed (disk full or permissions?)"
    fi
  else
    echo "⚠️ No registry at $REGISTRY — skip backup"
  fi

  # Watchdog: if a stray strategyEvolution is still running, log it (unusual after sync exit)
  if pgrep -f "node.*strategyEvolution" >/dev/null 2>&1; then
    echo "ℹ️ node strategyEvolution still listed by pgrep (parallel run?)"
  fi

  echo "💤 Sleep 60s…"
  sleep 60
done
