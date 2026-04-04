#!/usr/bin/env bash
# Preferred entry for near-live: loads .env, NEUROPILOT_DATA_ROOT, bounded CRITICAL_DATASETS,
# partial degrade, and optional SOFT_MONITOR_DATASETS (Yahoo visibility without hard-fail).
# Avoid: nohup node engine/ops/nearLiveBatchScheduler.js (unset CRITICAL_DATASETS => full manifest hard-fail).
set -euo pipefail

PROJECT_ROOT="/Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2"
cd "$PROJECT_ROOT"

mkdir -p "$PROJECT_ROOT/logs"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
# Crypto + XAU (Wave1 / learning); Yahoo equities excluded (overnight / closed-market stale noise).
_DEFAULT_NEUROPILOT_CRITICAL_DATASETS='BTCUSDT_5m,BTCUSDT_1h,ETHUSDT_5m,ETHUSDT_1h,SOLUSDT_5m,SOLUSDT_1h,BNBUSDT_5m,BNBUSDT_1h,ADAUSDT_5m,ADAUSDT_1h,XRPUSDT_5m,XRPUSDT_1h,XAUUSD_5m,XAUUSD_1h'
export NEUROPILOT_CRITICAL_DATASETS="${NEUROPILOT_CRITICAL_DATASETS:-$_DEFAULT_NEUROPILOT_CRITICAL_DATASETS}"
export NEUROPILOT_PARTIAL_DEGRADE_ON_STALE="${NEUROPILOT_PARTIAL_DEGRADE_ON_STALE:-1}"
_DEFAULT_NEUROPILOT_SOFT_MONITOR_DATASETS='AAPL_5m,AAPL_1h,IWM_5m,IWM_1h,NVDA_5m,NVDA_1h,QQQ_5m,QQQ_1h,SPY_5m,SPY_1h,TSLA_5m,TSLA_1h'
export NEUROPILOT_SOFT_MONITOR_DATASETS="${NEUROPILOT_SOFT_MONITOR_DATASETS:-$_DEFAULT_NEUROPILOT_SOFT_MONITOR_DATASETS}"

# Load secrets from .env without printing them.
ENV_FILE="${NEUROPILOT_ENV_FILE:-$PROJECT_ROOT/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

exec /usr/bin/env node "$PROJECT_ROOT/engine/ops/nearLiveBatchScheduler.js"
