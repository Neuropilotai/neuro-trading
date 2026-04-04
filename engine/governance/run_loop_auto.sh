#!/usr/bin/env bash
set -euo pipefail
# Supervision (watchdog / health / stack): watchdog_neuropilot.sh, monitor_neuropilot_health.sh, start_neuropilot_canonical.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-${REPO_ROOT}/data_workspace}"

BASE_SLEEP="${BASE_SLEEP:-10}"
SLOW_SLEEP="${SLOW_SLEEP:-60}"
FAST_SLEEP="${FAST_SLEEP:-5}"
REGRESSION_SLEEP="${REGRESSION_SLEEP:-120}"
REFRESH_EVERY_N_LOOPS="${REFRESH_EVERY_N_LOOPS:-6}"

LOG_DIR="${LOG_DIR:-logs}"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/run_loop_auto.log"

LOOP_COUNT=0

echo "[run_loop_auto] repo=$(pwd)" | tee -a "${LOG_FILE}"
echo "[run_loop_auto] data_root=${NEUROPILOT_DATA_ROOT}" | tee -a "${LOG_FILE}"
echo "[run_loop_auto] refresh_every_n_loops=${REFRESH_EVERY_N_LOOPS}" | tee -a "${LOG_FILE}"

run_refresh() {
  if [[ -x "engine/governance/refresh_datasets_auto.sh" ]]; then
    echo "[run_loop_auto] dataset refresh start" | tee -a "${LOG_FILE}"
    set +e
    local refresh_output
    refresh_output="$(bash engine/governance/refresh_datasets_auto.sh 2>&1)"
    local refresh_rc=$?
    set -e
    echo "${refresh_output}" | tee -a "${LOG_FILE}"
    echo "[run_loop_auto] dataset refresh rc=${refresh_rc}" | tee -a "${LOG_FILE}"
  else
    echo "[run_loop_auto] WARN refresh_datasets_auto.sh missing or not executable" | tee -a "${LOG_FILE}"
  fi
}

while true; do
  LOOP_COUNT=$((LOOP_COUNT + 1))

  echo "" | tee -a "${LOG_FILE}"
  echo "==============================" | tee -a "${LOG_FILE}"
  echo "LOOP START $(date) #${LOOP_COUNT}" | tee -a "${LOG_FILE}"
  echo "==============================" | tee -a "${LOG_FILE}"

  # Periodic dataset refresh
  if (( LOOP_COUNT == 1 || LOOP_COUNT % REFRESH_EVERY_N_LOOPS == 0 )); then
    run_refresh
  fi

  set +e
  OUTPUT="$(npm run governance:promoted-paper-7d-loop 2>&1)"
  RC=$?
  set -e

  echo "${OUTPUT}" | tee -a "${LOG_FILE}"

  STATUS="$(echo "${OUTPUT}" | grep 'OPERATOR_LOOP_STATUS=' | tail -1 | cut -d= -f2 || true)"
  STATUS="${STATUS:-UNKNOWN}"

  APPENDED="$(echo "${OUTPUT}" | grep -Eo '"effectiveAppended":[0-9]+' | tail -1 | cut -d: -f2 || true)"
  APPENDED="${APPENDED:-0}"

  echo "[run_loop_auto] status=${STATUS} rc=${RC} appended=${APPENDED}" | tee -a "${LOG_FILE}"

  if [[ "${RC}" -ne 0 ]]; then
    echo "[run_loop_auto] run failed, regression sleep ${REGRESSION_SLEEP}s" | tee -a "${LOG_FILE}"
    sleep "${REGRESSION_SLEEP}"
    continue
  fi

  case "${STATUS}" in
    HEALTHY_PROGRESS)
      if [[ "${APPENDED}" -gt 0 ]]; then
        echo "[run_loop_auto] fast loop ${FAST_SLEEP}s" | tee -a "${LOG_FILE}"
        sleep "${FAST_SLEEP}"
      else
        echo "[run_loop_auto] healthy but no append, base loop ${BASE_SLEEP}s" | tee -a "${LOG_FILE}"
        sleep "${BASE_SLEEP}"
      fi
      ;;
    STAGNATING)
      echo "[run_loop_auto] stagnating, slow loop ${SLOW_SLEEP}s" | tee -a "${LOG_FILE}"
      sleep "${SLOW_SLEEP}"
      ;;
    REGRESSION)
      echo "[run_loop_auto] regression, refresh next cycle + sleep ${REGRESSION_SLEEP}s" | tee -a "${LOG_FILE}"
      sleep "${REGRESSION_SLEEP}"
      ;;
    STABLE_OK)
      if [[ "${APPENDED}" -gt 0 ]]; then
        echo "[run_loop_auto] stable with append, base loop ${BASE_SLEEP}s" | tee -a "${LOG_FILE}"
      else
        echo "[run_loop_auto] stable no append, slow loop ${SLOW_SLEEP}s" | tee -a "${LOG_FILE}"
      fi
      if [[ "${APPENDED}" -gt 0 ]]; then
        sleep "${BASE_SLEEP}"
      else
        sleep "${SLOW_SLEEP}"
      fi
      ;;
    *)
      echo "[run_loop_auto] unknown status, base loop ${BASE_SLEEP}s" | tee -a "${LOG_FILE}"
      sleep "${BASE_SLEEP}"
      ;;
  esac
done
