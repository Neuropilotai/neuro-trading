#!/usr/bin/env bash
# Prop-firm health monitor: invokes monitorNeuropilotHealthCore.js (read-only).
# Writes ops-snapshot/neuropilot_health.{json,md} and logs/monitor_neuropilot_health.log
#
# Env: NEUROPILOT_DATA_ROOT, NEUROPILOT_OPS_SNAPSHOT_DIR

set -euo pipefail
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-${REPO_ROOT}/data_workspace}"
export NEUROPILOT_OPS_SNAPSHOT_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR:-${REPO_ROOT}/ops-snapshot}"

LOG_DIR="${LOG_DIR:-logs}"
mkdir -p "${LOG_DIR}"
MON_LOG="${MON_LOG:-${LOG_DIR}/monitor_neuropilot_health.log}"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

echo "[monitor_neuropilot_health $(ts)] run data_root=${NEUROPILOT_DATA_ROOT}" | tee -a "${MON_LOG}"
node "${SCRIPT_DIR}/monitorNeuropilotHealthCore.js" 2>&1 | tee -a "${MON_LOG}"
_ec="${PIPESTATUS[0]}"
echo "[monitor_neuropilot_health $(ts)] done exit=${_ec}" | tee -a "${MON_LOG}"
exit "${_ec}"
