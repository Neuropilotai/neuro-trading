#!/usr/bin/env bash
#
# NeuroPilot AI Startup — charge l'environnement, vérifie le 5TB, crée l'arbo, lance un test discovery.
# Usage: ~/np_start.sh  (après avoir copié ce script dans ton home et fait chmod +x)
#        ou depuis le projet (après source ~/.zshrc): ./scripts/np_start.sh
#

echo "===================================="
echo "NeuroPilot AI Startup"
echo "===================================="

# Load environment
if [[ -f "$HOME/.zshrc" ]]; then
  source "$HOME/.zshrc"
else
  echo "WARNING: ~/.zshrc not found. Set NEUROPILOT_* vars manually."
fi

echo ""
echo "Checking external drive..."

if [[ -n "$NEUROPILOT_DATA_ROOT" ]] && [[ -d "$NEUROPILOT_DATA_ROOT" ]]; then
  echo "5TB drive detected"
else
  echo "WARNING: 5TB drive not mounted (or NEUROPILOT_DATA_ROOT not set)"
  echo "Fallback will use local data_workspace"
fi

echo ""
echo "Checking directory structure..."

if [[ -n "$NEUROPILOT_DATA_ROOT" ]]; then
  mkdir -p "$NEUROPILOT_DATA_ROOT"/{datasets,features,discovery,generated_strategies,batch_results,bootstrap,walkforward,brain_snapshots,archives}
  echo "Folders OK"
else
  echo "NEUROPILOT_DATA_ROOT not set, skipping."
fi

echo ""
echo "Project location:"

if [[ -z "$NEUROPILOT_PROJECT_ROOT" ]]; then
  NEUROPILOT_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

cd "$NEUROPILOT_PROJECT_ROOT" || exit
pwd

echo ""
echo "Checking datasets..."

if [[ -n "$NEUROPILOT_DATA_ROOT" ]] && [[ -d "$NEUROPILOT_DATA_ROOT/datasets" ]]; then
  find "$NEUROPILOT_DATA_ROOT/datasets" -maxdepth 2 -type f 2>/dev/null | head -20
else
  echo "No datasets folder yet"
fi

echo ""
echo "Testing discovery engine..."

SYMBOL="${NP_DEFAULT_SYMBOL:-SPY}"
TF="${NP_DEFAULT_TF:-5m}"
node engine/discovery/runStrategyDiscovery.js "$SYMBOL" "$TF"

echo ""
echo "Listing outputs..."

if [[ -n "$NEUROPILOT_DATA_ROOT" ]] && [[ -d "$NEUROPILOT_DATA_ROOT" ]]; then
  find "$NEUROPILOT_DATA_ROOT" -maxdepth 2 -type f 2>/dev/null | head -20
else
  echo "No data root"
fi

echo ""
echo "NeuroPilot environment ready"
echo "===================================="
