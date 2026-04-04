#!/usr/bin/env bash
# Periodic health monitor + circuit breaker evaluate + optional alerts (desk quant).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-${REPO_ROOT}/data_workspace}"
export NEUROPILOT_OPS_SNAPSHOT_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR:-${REPO_ROOT}/ops-snapshot}"

INTERVAL="${NP_HEALTH_MONITOR_INTERVAL_SEC:-60}"
LOG_DIR="${LOG_DIR:-logs}"
OPS_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR}"
mkdir -p "${LOG_DIR}"
HL_LOG="${LOG_DIR}/health_monitor_loop.log"
LAST_FILE="${LOG_DIR}/.last_neuropilot_overall_status"
LAST_MODE="${LOG_DIR}/.last_neuropilot_incident_mode"

echo "[run_health_monitor_loop] interval_sec=${INTERVAL} — $(date -u '+%Y-%m-%dT%H:%M:%SZ')" | tee -a "${HL_LOG}"

have_jq() { command -v jq >/dev/null 2>&1; }

while true; do
  bash "${SCRIPT_DIR}/monitor_neuropilot_health.sh" >>"${HL_LOG}" 2>&1 || true

  node "${SCRIPT_DIR}/circuitBreakerNeuropilotCore.js" evaluate >>"${HL_LOG}" 2>&1 || true

  if have_jq && [[ -f "${OPS_DIR}/neuropilot_health.json" ]]; then
    CUR="$(jq -r '.overallStatus // empty' "${OPS_DIR}/neuropilot_health.json" 2>/dev/null || true)"
    PREV="$(cat "${LAST_FILE}" 2>/dev/null || true)"
    MODE="$(jq -r '.incidentMode // empty' "${OPS_DIR}/neuropilot_health.json" 2>/dev/null || true)"
    PREV_MODE="$(cat "${LAST_MODE}" 2>/dev/null || true)"
    FP="$(jq -r '.incidentFingerprint // "na"' "${OPS_DIR}/neuropilot_health.json" 2>/dev/null || true)"
    CONC="$(jq -r '.topConcerns | join(" · ")' "${OPS_DIR}/neuropilot_health.json" 2>/dev/null | head -c 400)"

    if [[ "${CUR}" == "CRITICAL" ]] && [[ "${CUR}" != "${PREV}" ]]; then
      bash "${SCRIPT_DIR}/send_neuropilot_alert.sh" \
        --severity critical \
        --title "NeuroPilot health CRITICAL" \
        --message "${CONC}" \
        --fingerprint "${FP}_crit" \
        --context-json "${OPS_DIR}/incident_status.json" >>"${HL_LOG}" 2>&1 || true
    fi

    if [[ "${MODE}" == "circuit_breaker" ]] && [[ "${MODE}" != "${PREV_MODE}" ]]; then
      bash "${SCRIPT_DIR}/send_neuropilot_alert.sh" \
        --severity critical \
        --title "NeuroPilot circuit breaker mode" \
        --message "incidentMode=circuit_breaker — ${CONC}" \
        --fingerprint "${FP}_cb" >>"${HL_LOG}" 2>&1 || true
    fi

    if [[ "${CUR}" == "DEGRADED" ]] && [[ "${CUR}" != "${PREV}" ]] && [[ "${PREV}" == "HEALTHY" ]]; then
      bash "${SCRIPT_DIR}/send_neuropilot_alert.sh" \
        --severity warn \
        --title "NeuroPilot health degraded" \
        --message "${CONC}" \
        --fingerprint "${FP}_deg" >>"${HL_LOG}" 2>&1 || true
    fi

    echo -n "${CUR}" >"${LAST_FILE}" 2>/dev/null || true
    echo -n "${MODE}" >"${LAST_MODE}" 2>/dev/null || true
  fi

  sleep "${INTERVAL}"
done
