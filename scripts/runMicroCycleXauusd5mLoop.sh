#!/usr/bin/env bash
# Loop wrapper: repeatedly runs scripts/runMicroCycleXauusd5m.sh (orchestration only).
# Each iteration calls startExperiment inside that script → new EXPERIMENT_ID per cycle;
# experiment_registry.json will accumulate many entries over time.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

MICRO_SCRIPT="${PROJECT_ROOT}/scripts/runMicroCycleXauusd5m.sh"
LOG_DIR="${PROJECT_ROOT}/logs"
DEFAULT_LOG="${LOG_DIR}/micro_cycle_xauusd_5m_loop.log"
LOG_FILE="${MICRO_CYCLE_LOG_FILE:-$DEFAULT_LOG}"
SLEEP_SEC="${MICRO_CYCLE_SLEEP_SEC:-300}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

log() {
  # UTC prefix per spec; message also visible on terminal via tee
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG_FILE}"
}

shutdown() {
  log "Shutdown signal received (INT/TERM); exiting loop."
  exit 130
}

trap shutdown INT TERM

require_cmd node

if [[ -z "${NEUROPILOT_DATA_ROOT:-}" ]] || [[ ! -d "${NEUROPILOT_DATA_ROOT}" ]]; then
  echo "ERROR: NEUROPILOT_DATA_ROOT must be set to an existing directory." >&2
  exit 1
fi

if [[ ! -f "${MICRO_SCRIPT}" ]]; then
  echo "ERROR: micro-cycle script missing: ${MICRO_SCRIPT}" >&2
  exit 1
fi

mkdir -p "$(dirname "${LOG_FILE}")"
touch "${LOG_FILE}"

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "Micro-cycle loop — config"
log "  repo_root:     ${PROJECT_ROOT}"
log "  data_root:     ${NEUROPILOT_DATA_ROOT}"
log "  sleep_sec:     ${SLEEP_SEC}"
log "  log_file:      ${LOG_FILE}"
log "  micro_script:  ${MICRO_SCRIPT}"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cycle=0
while true; do
  cycle=$((cycle + 1))
  TS_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  TS_LOCAL="$(date +%Y-%m-%dT%H:%M:%S%z)"
  log ""
  log "=== MICRO CYCLE LOOP START cycle=${cycle} utc=${TS_UTC} local=${TS_LOCAL} ==="

  set +e
  bash "${MICRO_SCRIPT}" 2>&1 | tee -a "${LOG_FILE}"
  rc="${PIPESTATUS[0]}"
  set -e

  if [[ "${rc}" -eq 0 ]]; then
    log "Cycle ${cycle} completed successfully (exit 0)."
    log "Sleeping ${SLEEP_SEC}s before next run."
    sleep "${SLEEP_SEC}"
  else
    log "Cycle ${cycle} failed (exit ${rc}); exiting loop."
    exit 1
  fi
done
