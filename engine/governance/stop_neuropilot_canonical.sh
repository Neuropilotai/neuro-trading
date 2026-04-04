#!/usr/bin/env bash
# Stop prop-firm supervisor stack (narrow patterns + PIDs from stack file).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

LOG_DIR="${LOG_DIR:-logs}"
OPS_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR:-${REPO_ROOT}/ops-snapshot}"
PID_FILE="${LOG_DIR}/neuropilot_supervisor_stack.pids"
CANON_PID="${LOG_DIR}/canonical_stack.pids"
SUP_JSON="${OPS_DIR}/supervisor_status.json"
PORT="${NP_HTTP_PORT:-8080}"

echo "[stop_neuropilot_canonical] repo=${REPO_ROOT}"

kill_pid_file() {
  local f="${1:-${PID_FILE}}"
  [[ -f "${f}" ]] || return 0
  while IFS= read -r line; do
    [[ -z "${line}" ]] || [[ "${line}" =~ ^# ]] && continue
    local name="${line%%=*}"
    local pid="${line##*=}"
    [[ -z "${pid}" ]] && continue
    if kill -0 "${pid}" 2>/dev/null; then
      echo "[stop_neuropilot_canonical] kill ${name}=${pid}"
      kill "${pid}" 2>/dev/null || true
    fi
  done <"${f}"
}

kill_pid_file "${PID_FILE}"
[[ -f "${CANON_PID}" ]] && kill_pid_file "${CANON_PID}"
sleep 1

# Narrow pattern kills (supervisor components only)
for pat in \
  'engine/governance/run_loop_auto\.sh' \
  'engine/governance/watchdog_neuropilot\.sh' \
  'engine/governance/run_health_monitor_loop\.sh' \
  'engine/governance/run_replay_boost_policy_loop\.sh' \
  'engine/governance/serve_dashboard_local\.sh'
do
  if pgrep -f "${pat}" >/dev/null 2>&1; then
    echo "[stop_neuropilot_canonical] pkill -f ${pat}"
    pkill -f "${pat}" 2>/dev/null || true
  fi
done

if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -ti ":${PORT}" 2>/dev/null); do
    echo "[stop_neuropilot_canonical] kill port ${PORT} PID=${pid}"
    kill "${pid}" 2>/dev/null || true
  done
fi

: >"${PID_FILE}" 2>/dev/null || true
: >"${CANON_PID}" 2>/dev/null || true

export SUP_STOP_JSON="${SUP_JSON}"
export OPS_STOP_DIR="${OPS_DIR}"
node -e "
const fs=require('fs');
const path=require('path');
const p=process.env.SUP_STOP_JSON;
const ops=process.env.OPS_STOP_DIR;
if(!fs.existsSync(p)) process.exit(0);
let j={};
try{j=JSON.parse(fs.readFileSync(p,'utf8'));}catch{}
j.supervisorStatus='STOPPED';
j.stoppedAt=new Date().toISOString();
j.replayBoostPolicyLoopRunning=false;
try {
  const cb=JSON.parse(fs.readFileSync(path.join(ops,'circuit_breaker_status.json'),'utf8'));
  j.circuitBreakerState=cb.state||j.circuitBreakerState||null;
} catch {}
fs.writeFileSync(p,JSON.stringify(j,null,2));
" 2>/dev/null || true

echo "[stop_neuropilot_canonical] done. supervisor_status → STOPPED (${SUP_JSON})"
