#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

PROJECT_ROOT="${NEUROPILOT_PROJECT_ROOT:-$HOME/neuro-pilot-ai/neuropilot_trading_v2}"
DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
GDRIVE_ROOT="${NEUROPILOT_GDRIVE_BACKUP_ROOT:-}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "[ERROR] node not found in PATH=$PATH" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

TS="$(date +%Y%m%d_%H%M%S)"
LOCAL_LOG_DIR="$PROJECT_ROOT/nightly_logs"
mkdir -p "$LOCAL_LOG_DIR"
LOG_FILE="$LOCAL_LOG_DIR/nightly_${TS}.log"

if [[ -d "$DATA_ROOT/nightly_logs" && -w "$DATA_ROOT/nightly_logs" ]]; then
  TARGET_LOG_FILE="$DATA_ROOT/nightly_logs/nightly_${TS}.log"
else
  TARGET_LOG_FILE=""
fi

exec > >(tee -a "$LOG_FILE") 2>&1

echo "======================================"
echo "NeuroPilot Nightly Lab started: $TS"
echo "PROJECT_ROOT=$PROJECT_ROOT"
echo "DATA_ROOT=$DATA_ROOT"
echo "GDRIVE_ROOT=$GDRIVE_ROOT"
echo "NODE_BIN=$NODE_BIN"
echo "======================================"
echo

if [[ ! -d "$DATA_ROOT" ]]; then
  echo "[ERROR] DATA_ROOT missing: $DATA_ROOT"
  exit 1
fi

mkdir -p "$DATA_ROOT"/{datasets,features,generated_strategies,batch_results,bootstrap,discovery,brain_snapshots,champion_setups,evolution_runs,nightly_logs,archives}

sleep 30

# Optional: Strategy Parameter Space (PARAMETER_GRID_PATTERNS=1 → 108 setups, 10 → 1080)
if [[ -n "${PARAMETER_GRID_PATTERNS:-}" && "${PARAMETER_GRID_PATTERNS}" -gt 0 ]]; then
  echo "[0] Parameter grid discovery (${PARAMETER_GRID_PATTERNS} pattern(s))"
  export NEUROPILOT_DATA_ROOT="$DATA_ROOT"
  "$NODE_BIN" engine/discovery/parameterGridDiscovery.js "$PARAMETER_GRID_PATTERNS" write || echo "[WARN] Parameter grid failed"
  echo
fi

echo "[1/9] Discovery SPY 5m"
"$NODE_BIN" engine/discovery/runStrategyDiscovery.js SPY 5m
echo

echo "[2/9] Discovery QQQ 5m"
"$NODE_BIN" engine/discovery/runStrategyDiscovery.js QQQ 5m
echo

echo "[3/9] Discovery IWM 5m if data exists"
if [[ -f "$DATA_ROOT/datasets/iwm/iwm_5m.csv" || -f "$PROJECT_ROOT/data/iwm_5m.csv" ]]; then
  "$NODE_BIN" engine/discovery/runStrategyDiscovery.js IWM 5m
else
  echo "[SKIP] IWM dataset not found"
fi
echo

# Crypto (uncomment when datasets exist: datasets/btcusdt/, ethusdt/, solusdt/)
if [[ -d "$DATA_ROOT/datasets/btcusdt" || -f "$DATA_ROOT/datasets/btcusdt/btcusdt_5m.csv" ]]; then
  echo "[3b/9] Discovery BTCUSDT 5m"
  "$NODE_BIN" engine/discovery/runStrategyDiscovery.js BTCUSDT 5m
  echo
  if [[ -f "$DATA_ROOT/datasets/btcusdt/btcusdt_1h.csv" ]]; then
    echo "[3c/9] Discovery BTCUSDT 1h"
    "$NODE_BIN" engine/discovery/runStrategyDiscovery.js BTCUSDT 1h
    echo
  fi
fi

echo "[4/9] Brain snapshot"
if [[ -f "$DATA_ROOT/discovery/discovered_setups.json" ]]; then
  if cp "$DATA_ROOT/discovery/discovered_setups.json" "$DATA_ROOT/brain_snapshots/discovered_setups_${TS}.json" 2>/dev/null; then
    echo "[OK] discovered_setups snapshot saved"
  else
    echo "[WARN] Could not snapshot discovered_setups.json"
  fi
else
  echo "[WARN] discovered_setups.json absent"
fi

if [[ -f "$DATA_ROOT/batch_results/strategy_batch_results.json" ]]; then
  if cp "$DATA_ROOT/batch_results/strategy_batch_results.json" "$DATA_ROOT/brain_snapshots/strategy_batch_results_${TS}.json" 2>/dev/null; then
    echo "[OK] strategy_batch_results snapshot saved"
  else
    echo "[WARN] Could not snapshot strategy_batch_results.json"
  fi
else
  echo "[WARN] strategy_batch_results.json absent"
fi
echo

echo "[5/9] Strategy Mutation"
export NEUROPILOT_DATA_ROOT="$DATA_ROOT"
"$NODE_BIN" engine/evolution/strategyMutation.js 5 8 || echo "[WARN] Strategy mutation failed"
echo

echo "[6/9] Strategy Evolution"
export NEUROPILOT_DATA_ROOT="$DATA_ROOT"
"$NODE_BIN" engine/evolution/strategyEvolution.js || echo "[WARN] Strategy evolution failed (no snapshots yet?)"
echo

echo "[7/9] Genetic Mutation + Crossover"
export NEUROPILOT_DATA_ROOT="$DATA_ROOT"
"$NODE_BIN" engine/evolution/runGeneticEvolution.js 10 3 5 || echo "[WARN] Genetic evolution failed"
echo

echo "[8/9] Backup to Google Drive if available"
if [[ -n "$GDRIVE_ROOT" && -d "$GDRIVE_ROOT" ]]; then
  "$PROJECT_ROOT/scripts/backup_discovery_to_gdrive.sh" --dated || echo "[WARN] Google Drive backup failed"
else
  echo "[SKIP] Google Drive indisponible"
fi
echo

echo "[9/9] Finalizing logs"
if [[ -n "$TARGET_LOG_FILE" ]]; then
  cp "$LOG_FILE" "$TARGET_LOG_FILE" 2>/dev/null || echo "[WARN] Could not copy nightly log to $TARGET_LOG_FILE"
else
  echo "[WARN] 5TB nightly_logs not writable; log kept locally at $LOG_FILE"
fi

echo
echo "NeuroPilot Nightly Lab finished: $(date '+%Y-%m-%d %H:%M:%S')"
echo "Local log: $LOG_FILE"
if [[ -n "$TARGET_LOG_FILE" ]]; then
  echo "5TB log: $TARGET_LOG_FILE"
fi
