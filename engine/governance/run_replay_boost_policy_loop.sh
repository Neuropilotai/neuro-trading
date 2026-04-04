#!/usr/bin/env bash
# Best-effort periodic rebuild of governance/replay_boost_policy.json (desk-quant policy).
# Does not affect the canonical trading loop if this script fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-${REPO_ROOT}/data_workspace}"
export NEUROPILOT_OPS_SNAPSHOT_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR:-${REPO_ROOT}/ops-snapshot}"

INTERVAL="${NP_REPLAY_BOOST_POLICY_INTERVAL_SEC:-120}"
LOG_DIR="${LOG_DIR:-logs}"
mkdir -p "${LOG_DIR}"
LOG="${LOG_DIR}/replay_boost_policy_loop.log"

echo "[run_replay_boost_policy_loop] interval_sec=${INTERVAL} data_root=${NEUROPILOT_DATA_ROOT} — $(date -u '+%Y-%m-%dT%H:%M:%SZ')" | tee -a "${LOG}"

while true; do
  if node "${SCRIPT_DIR}/buildReplayBoostPolicy.js" >>"${LOG}" 2>&1; then
    echo "[run_replay_boost_policy_loop] ok $(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"${LOG}"
  else
    echo "[run_replay_boost_policy_loop] WARN build failed $(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"${LOG}"
  fi
  sleep "${INTERVAL}"
done
