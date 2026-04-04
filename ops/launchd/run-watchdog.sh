#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2"
cd "$PROJECT_ROOT"

mkdir -p "$PROJECT_ROOT/logs"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
export NEUROPILOT_WATCHDOG_INTERVAL_SEC="${NEUROPILOT_WATCHDOG_INTERVAL_SEC:-300}"

# Load secrets / webhook config from .env without printing them.
ENV_FILE="${NEUROPILOT_ENV_FILE:-$PROJECT_ROOT/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

exec /usr/bin/env node "$PROJECT_ROOT/engine/scripts/opsWatchdog.js"
