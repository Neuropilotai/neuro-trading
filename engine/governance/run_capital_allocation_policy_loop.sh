#!/usr/bin/env bash
# Best-effort periodic rebuild of governance/capital_allocation_policy.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-${REPO_ROOT}/data_workspace}"
export NEUROPILOT_OPS_SNAPSHOT_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR:-${REPO_ROOT}/ops-snapshot}"

INTERVAL="${NP_CAPITAL_ALLOCATION_POLICY_INTERVAL_SEC:-120}"
LOG_DIR="${LOG_DIR:-logs}"
mkdir -p "${LOG_DIR}"
LOG="${LOG_DIR}/capital_allocation_policy_loop.log"

echo "[run_capital_allocation_policy_loop] interval_sec=${INTERVAL} data_root=${NEUROPILOT_DATA_ROOT} — $(date -u '+%Y-%m-%dT%H:%M:%SZ')" | tee -a "${LOG}"

while true; do
  LOOP_ON="${NP_CAPITAL_ALLOCATION_POLICY_LOOP_ENABLE:-1}"
  if [[ "${LOOP_ON}" == "0" || "${LOOP_ON}" == "false" || "${LOOP_ON}" == "off" ]]; then
    echo "[run_capital_allocation_policy_loop] disabled — $(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"${LOG}"
    sleep "${INTERVAL}"
    continue
  fi
  if node "${SCRIPT_DIR}/buildCapitalAllocationPolicy.js" >>"${LOG}" 2>&1; then
    echo "[run_capital_allocation_policy_loop] ok $(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"${LOG}"
  else
    echo "[run_capital_allocation_policy_loop] WARN build failed $(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"${LOG}"
  fi
  sleep "${INTERVAL}"
done
