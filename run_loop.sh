#!/bin/bash
set -euo pipefail

cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2

export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"
export NEUROPILOT_WF_MERGE_SIBLING=1

FULL_RUN_CMD="./engine/scripts/runFullPipelineExpanded.sh"

echo "🚀 NeuroPilot full pipeline loop started"

while true; do
  echo "-----------------------------"
  echo "⏱ Full run started at $(date)"

  if [ ! -f "$FULL_RUN_CMD" ]; then
    echo "❌ Full pipeline script not found: $FULL_RUN_CMD"
    exit 1
  fi

  bash "$FULL_RUN_CMD"

  echo "📊 Export snapshot"
  node engine/evolution/scripts/exportOpsSnapshot.js

  echo "✅ Full run completed at $(date)"
  echo "😴 Sleeping 60 seconds..."
  sleep 60
done
