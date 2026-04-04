#!/usr/bin/env bash
# Baseline evolution run with recommended wildcard tuning.
#
# Scope: strategyEvolution + audit + metrics export only.
# Does NOT run: buildNextGenerationFromChampions, runStrategyBatch, runMetaPipeline.
# NEUROPILOT_MUTATION_HOTSPOT_POLICY=1 has no effect here — hotspot applies only when
# buildNextGenerationFromChampions.js runs. For Phase 1 hotspot test: next-gen → batch → meta → then this script (or full pipeline).
# New setup_mut_*.json on disk are invisible to evolution until batch + meta rebuild
# discovery/meta_ranking.json (or they appear in nightly brain_snapshots history).
#
# Usage: from neuropilot_trading_v2:
#   ./engine/evolution/scripts/runEvolutionBaseline.sh
# Or with custom data root:
#   NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI ./engine/evolution/scripts/runEvolutionBaseline.sh
#
# Same inputs → deterministic evolution output (dashboard may show Data freshness: STALLED). That is expected.
#
# Looser wildcard (more movement) — pick one:
#   A) One-shot env:
#        EVOLUTION_WILDCARD_MIN_DELTA=0.0005 EVOLUTION_WILDCARD_MAX_PROMOTIONS=6 ./engine/evolution/scripts/runEvolutionBaseline.sh
#   B) Preset flag (only applies defaults if vars are unset):
#        EVOLUTION_BASELINE_WILDCARD_MOVEMENT=1 ./engine/evolution/scripts/runEvolutionBaseline.sh
# Debug why candidates are blocked (stderr, JSON lines):
#   EVOLUTION_DEBUG_WILDCARD=1 ./engine/evolution/scripts/runEvolutionBaseline.sh

set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_ROOT"

export EVOLUTION_WILDCARD_ENABLE="${EVOLUTION_WILDCARD_ENABLE:-1}"

if [[ "${EVOLUTION_BASELINE_WILDCARD_MOVEMENT:-0}" == "1" ]]; then
  : "${EVOLUTION_WILDCARD_MIN_DELTA:=0.0005}"
  : "${EVOLUTION_WILDCARD_MAX_PROMOTIONS:=6}"
else
  : "${EVOLUTION_WILDCARD_MIN_DELTA:=0.001}"
  : "${EVOLUTION_WILDCARD_MAX_PROMOTIONS:=4}"
fi
export EVOLUTION_WILDCARD_MIN_DELTA
export EVOLUTION_WILDCARD_MAX_PROMOTIONS

echo "Evolution baseline (wildcard enable=$EVOLUTION_WILDCARD_ENABLE minDelta=$EVOLUTION_WILDCARD_MIN_DELTA maxPromotions=$EVOLUTION_WILDCARD_MAX_PROMOTIONS)"
if [[ "${NEUROPILOT_OWNER_APPROVAL_GATE:-0}" == "1" ]]; then
  node engine/evolution/scripts/checkOwnerApprovalAllowNextCycle.js
fi
node engine/evolution/strategyEvolution.js
node engine/evolution/validateWildcardPass.js
node engine/evolution/auditRegistryConsistency.js
echo "Audit Exit: $?"
node engine/evolution/scripts/appendEvolutionMetricsLog.js
# Export snapshot for ops.neuropilot.dev
node engine/evolution/scripts/exportOpsSnapshot.js
# Optional: run owner-bound actions (reconcile deep, etc.) — requires NEUROPILOT_ENABLE_OWNER_ACTIONS=1 in production
if [[ "${NEUROPILOT_ENABLE_OWNER_ACTIONS:-0}" == "1" ]]; then
  node engine/execution/ownerApprovalActionWorker.js
fi
