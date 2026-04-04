#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-${REPO_ROOT}/data_workspace}"
LOG_DIR="${LOG_DIR:-logs}"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/refresh_datasets_auto.log"

echo "" | tee -a "${LOG_FILE}"
echo "==============================" | tee -a "${LOG_FILE}"
echo "DATA REFRESH START $(date)" | tee -a "${LOG_FILE}"
echo "repo=${REPO_ROOT}" | tee -a "${LOG_FILE}"
echo "data_root=${NEUROPILOT_DATA_ROOT}" | tee -a "${LOG_FILE}"
echo "==============================" | tee -a "${LOG_FILE}"

run_cmd() {
  local label="$1"
  shift
  echo "[refresh_datasets_auto] ${label}" | tee -a "${LOG_FILE}"
  set +e
  local output
  output="$("$@" 2>&1)"
  local rc=$?
  set -e
  echo "${output}" | tee -a "${LOG_FILE}"
  if [[ $rc -ne 0 ]]; then
    echo "[refresh_datasets_auto] WARN ${label} failed rc=${rc}" | tee -a "${LOG_FILE}"
  fi
  return 0
}

# 1) Refresh market data if your chain exists
if [[ -f "engine/governance/runPaperDataRefreshChain.js" ]]; then
  run_cmd "runPaperDataRefreshChain" node engine/governance/runPaperDataRefreshChain.js
else
  echo "[refresh_datasets_auto] INFO no runPaperDataRefreshChain.js found, skipping" | tee -a "${LOG_FILE}"
fi

# 2) Rebuild promoted manifest
if [[ -f "engine/governance/buildPromotedManifest.js" ]]; then
  run_cmd "buildPromotedManifest" node engine/governance/buildPromotedManifest.js
fi

# 3) Rebuild paper signals
if [[ -f "engine/governance/buildPaperExecutionV1SignalsWave1.js" ]]; then
  run_cmd "buildPaperExecutionV1SignalsWave1" node engine/governance/buildPaperExecutionV1SignalsWave1.js
fi

# 4) Refresh ops snapshot once after data refresh
if [[ -f "engine/evolution/scripts/exportOpsSnapshot.js" ]]; then
  run_cmd "exportOpsSnapshot" node engine/evolution/scripts/exportOpsSnapshot.js
fi

echo "[refresh_datasets_auto] DONE $(date)" | tee -a "${LOG_FILE}"
