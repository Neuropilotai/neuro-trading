#!/usr/bin/env bash
# Orchestration only: manual micro-cycle XAUUSD 5m + experiment_registry traceability.
# Does not change engine behavior. Run from anywhere; resolves repo root from this file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

section() {
  echo
  echo "=== $1 ==="
}

require_file() {
  local f="$1"
  local msg="$2"
  if [[ ! -f "$f" ]]; then
    echo "ERROR: ${msg}" >&2
    echo "  Expected file: $f" >&2
    exit 1
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

require_cmd node
require_cmd jq

if [[ -z "${NEUROPILOT_DATA_ROOT:-}" ]] || [[ ! -d "${NEUROPILOT_DATA_ROOT}" ]]; then
  echo "ERROR: NEUROPILOT_DATA_ROOT must be set to an existing directory." >&2
  exit 1
fi

CSV_PATH="${NEUROPILOT_DATA_ROOT}/datasets/xauusd/xauusd_5m.csv"
require_file "${CSV_PATH}" "XAUUSD 5m dataset CSV missing"

export EXPERIMENT_NOTE="${EXPERIMENT_NOTE:-micro XAUUSD 5m}"
TOP_N="${TOP_N:-30}"
PORTFOLIO_MAX="${PORTFOLIO_MAX:-12}"
export NEUROPILOT_HYBRID_PROMOTION_ENABLE=1

section "1/8 Start experiment"
export EXPERIMENT_ID="$(node -e 'const g=require("./engine/governance/experimentRegistry"); console.log(g.startExperiment({ note: process.env.EXPERIMENT_NOTE || "micro XAUUSD 5m" }));')"
export NEUROPILOT_CYCLE_ID="${EXPERIMENT_ID}"
echo "EXPERIMENT_ID=${EXPERIMENT_ID}"

section "2/8 Next generation"
node engine/evolution/buildNextGenerationFromChampions.js

section "3/8 CSV → binary (XAUUSD 5m)"
node engine/scripts/csvToBinary.js "${CSV_PATH}" XAUUSD 5m

section "4/8 Two-stage discovery (dataGroup xauusd_5m)"
node engine/discovery/runTwoStageDiscovery.js XAUUSD 5m xauusd_5m

section "5/8 Meta pipeline"
echo "dataRoot (before meta): $(node -e "console.log(require('./engine/dataRoot').getDataRoot())")"
node engine/meta/runMetaPipeline.js "${TOP_N}" "${PORTFOLIO_MAX}"
META_JSON="${NEUROPILOT_DATA_ROOT}/discovery/meta_ranking.json"
require_file "${META_JSON}" "meta_ranking.json missing after meta pipeline"
jq '.generatedAt, .experimentId, .topN, .totalStrategiesRanked' "${META_JSON}"

section "6/8 Strategy evolution"
node engine/evolution/strategyEvolution.js

section "7/8 Ops snapshot (hybrid enabled)"
node engine/evolution/scripts/exportOpsSnapshot.js

section "8/8 Append experiment artifacts"
node -e '
const g = require("./engine/governance/experimentRegistry");
const path = require("path");
const dr = require("./engine/dataRoot");
const p = process.env.NEUROPILOT_DATA_ROOT && String(process.env.NEUROPILOT_DATA_ROOT).trim()
  ? path.resolve(process.env.NEUROPILOT_DATA_ROOT.trim())
  : dr.getDataRoot();
const id = process.env.EXPERIMENT_ID;
if (!id) {
  console.error("EXPERIMENT_ID missing");
  process.exit(1);
}
g.appendArtifact(id, "meta", path.join(p, "discovery", "meta_ranking.json"));
g.appendArtifact(id, "portfolio", path.join(p, "discovery", "strategy_portfolio.json"));
g.appendArtifact(id, "registry", path.join(p, "champion_setups", "champion_registry.json"));
g.appendArtifact(id, "ops_snapshot", path.join(p, "discovery", "supervisor_config.json"));
console.log("appendArtifact: meta, portfolio, registry, ops_snapshot OK");
'

section "Verification"
REG_JSON="${NEUROPILOT_DATA_ROOT}/governance/experiment_registry.json"
require_file "${REG_JSON}" "experiment_registry.json missing"
jq '.experiments[-1] | {experimentId, artifacts}' "${REG_JSON}"

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Micro-cycle XAUUSD 5m — orchestration-only script completed OK"
echo "EXPERIMENT_ID=${EXPERIMENT_ID}"
echo "Key artifacts:"
echo "  meta_ranking:       ${NEUROPILOT_DATA_ROOT}/discovery/meta_ranking.json"
echo "  strategy_portfolio: ${NEUROPILOT_DATA_ROOT}/discovery/strategy_portfolio.json"
echo "  champion_registry:  ${NEUROPILOT_DATA_ROOT}/champion_setups/champion_registry.json"
echo "  supervisor_config:  ${NEUROPILOT_DATA_ROOT}/discovery/supervisor_config.json"
echo "  experiment_registry: ${REG_JSON}"
echo "  ops-snapshot (default): ${PROJECT_ROOT}/ops-snapshot/"
echo "This script only wraps existing Node commands; no business logic was added or changed."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
