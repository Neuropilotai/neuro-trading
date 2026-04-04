#!/usr/bin/env bash
# Desk-quant watchdog: loop process + dual heartbeat + bounded restarts + circuit breaker gate.
# Does not modify trading/paper logic.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-${REPO_ROOT}/data_workspace}"
export NEUROPILOT_OPS_SNAPSHOT_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR:-${REPO_ROOT}/ops-snapshot}"
OPS_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR}"

LOOP_PATTERN="${NEUROPILOT_LOOP_PATTERN:-engine/governance/run_loop_auto\\.sh}"
MAX_LOOP_SILENCE_SEC="${NP_WATCHDOG_MAX_LOOP_SILENCE_SEC:-600}"
MAX_DASH_SILENCE_SEC="${NP_WATCHDOG_MAX_DASH_SILENCE_SEC:-900}"
POLL_SEC="${NP_WATCHDOG_POLL_SEC:-20}"
COOLDOWN_SEC="${NP_WATCHDOG_RESTART_COOLDOWN_SEC:-60}"
MAX_RESTARTS_HOUR="${NP_WATCHDOG_MAX_RESTARTS_PER_HOUR:-6}"
ENABLE_RESTART="${NP_WATCHDOG_ENABLE_RESTART:-1}"
ONE_SHOT="${NP_WATCHDOG_ONE_SHOT:-0}"
IGNORE_CB="${NP_WATCHDOG_IGNORE_CIRCUIT_BREAKER:-0}"

LOG_DIR="${LOG_DIR:-logs}"
mkdir -p "${LOG_DIR}" "${OPS_DIR}"
WATCHDOG_LOG="${NEUROPILOT_WATCHDOG_LOG:-${LOG_DIR}/watchdog_neuropilot.log}"
LOCK_DIR="${LOG_DIR}/neuropilot_restart.lock"
STATUS_JSON="${OPS_DIR}/watchdog_status.json"
CB_NODE="${SCRIPT_DIR}/circuitBreakerNeuropilotCore.js"

LAST_RUN_PATH="${NEUROPILOT_DATA_ROOT}/governance/paper_exec_v1_last_run.json"
DASH_JSON="${OPS_DIR}/governance_dashboard.json"
LOOP_SCRIPT="${REPO_ROOT}/engine/governance/run_loop_auto.sh"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

log_line() {
  echo "[watchdog_neuropilot $(ts)] $*" | tee -a "${WATCHDOG_LOG}"
}

iso_age_sec() {
  local f="$1"
  local field="${2:-writtenAt}"
  node -e "
const fs = require('fs');
const p = process.argv[1];
const field = process.argv[2] || 'writtenAt';
if (!fs.existsSync(p)) { console.log(-1); process.exit(0); }
let j;
try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { console.log(-1); process.exit(0); }
const iso = j[field] || j.generatedAt || '';
const t = Date.parse(iso);
console.log(Number.isFinite(t) ? ((Date.now() - t) / 1000) : -1);
" "$f" "$field"
}

loop_running() { pgrep -f "${LOOP_PATTERN}" >/dev/null 2>&1; }

restarts_last_hour() {
  node -e "
const fs=require('fs');
const p='${STATUS_JSON}';
let j={};
try{if(fs.existsSync(p)) j=JSON.parse(fs.readFileSync(p,'utf8'));}catch{}
const arr=Array.isArray(j.restartHistory)?j.restartHistory:[];
const h=Date.now()-3600000;
console.log(arr.filter(x=>{const t=Date.parse(x);return Number.isFinite(t)&&t>=h;}).length);
" 2>/dev/null || echo "0"
}

write_watchdog_status() {
  node -e "
const fs=require('fs');
const p=process.argv[1];
const o={
  generatedAt:new Date().toISOString(),
  dataRoot:process.env.NEUROPILOT_DATA_ROOT||'',
  loopProcessRunning:process.argv[2]==='1',
  lastRunWrittenAtAgeSec:parseFloat(process.argv[3]||'-1'),
  dashboardGeneratedAtAgeSec:parseFloat(process.argv[4]||'-1'),
  action:process.argv[5]||'ok',
  lastRestartReason:process.argv[6]==='none'?null:process.argv[6],
  lastWatchdogCheckAt:new Date().toISOString(),
  circuitBreakerEscalation:false,
};
let prev={};
try { if(fs.existsSync(p)) prev=JSON.parse(fs.readFileSync(p,'utf8')); } catch {}
if(prev.lastRestartAt) o.lastRestartAt=prev.lastRestartAt;
if(prev.restartCountTotal!=null) o.restartCountTotal=prev.restartCountTotal; else o.restartCountTotal=0;
if(Array.isArray(prev.restartHistory)) o.restartHistory=prev.restartHistory;
if(prev.circuitBreakerEscalation===true) o.circuitBreakerEscalation=true;
fs.mkdirSync(require('path').dirname(p),{recursive:true});
fs.writeFileSync(p,JSON.stringify(o,null,2));
" "${STATUS_JSON}" "$@"
}

cooldown_blocks() {
  node -e "
const fs=require('fs');
const p='${STATUS_JSON}';
const cd=${COOLDOWN_SEC};
if(!fs.existsSync(p)) process.exit(1);
let t=0;
try {
  const j=JSON.parse(fs.readFileSync(p,'utf8'));
  t=Date.parse(j.lastRestartAt||'');
} catch {}
if(!Number.isFinite(t)) process.exit(1);
const age=(Date.now()-t)/1000;
process.exit(age < cd ? 0 : 1);
" 2>/dev/null && return 0
  return 1
}

restart_loop() {
  local reason="$1"
  log_line "RESTART requested reason=${reason} enable_restart=${ENABLE_RESTART}"

  if [[ "${ENABLE_RESTART}" != "1" ]]; then
    return 0
  fi

  if [[ "${IGNORE_CB}" != "1" ]]; then
    if ! node "${CB_NODE}" is-restart-allowed 2>/dev/null; then
      log_line "SKIP restart: circuit breaker closed restart path (OPEN or HALF_OPEN quota spent)"
      return 0
    fi
  fi

  local rcount
  rcount="$(restarts_last_hour)"
  if [[ "${rcount}" -ge "${MAX_RESTARTS_HOUR}" ]]; then
    log_line "ESCALATION restarts_last_hour=${rcount} max=${MAX_RESTARTS_HOUR} — opening circuit breaker"
    node "${CB_NODE}" set-state OPEN max_restarts_per_hour >/dev/null 2>&1 || true
    node -e "
const fs=require('fs');
const p='${STATUS_JSON}';
let j={};
try{j=JSON.parse(fs.readFileSync(p));}catch{}
j.circuitBreakerEscalation=true;
fs.writeFileSync(p,JSON.stringify(j,null,2));
" 2>/dev/null || true
    return 0
  fi

  if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
    log_line "SKIP restart: lock dir exists ${LOCK_DIR}"
    return 0
  fi
  if [[ -f "${STATUS_JSON}" ]] && cooldown_blocks; then
    log_line "SKIP restart: within cooldown ${COOLDOWN_SEC}s since lastRestartAt"
    rmdir "${LOCK_DIR}" 2>/dev/null || true
    return 0
  fi

  pkill -f "${LOOP_PATTERN}" 2>/dev/null || true
  sleep 2
  if loop_running; then
    log_line "WARN pattern still running after pkill; abort start to avoid duplicates"
    rmdir "${LOCK_DIR}" 2>/dev/null || true
    return 0
  fi

  nohup bash "${LOOP_SCRIPT}" >>"${LOG_DIR}/run_loop_auto.outer.log" 2>&1 &
  log_line "started run_loop_auto PID=$! reason=${reason}"

  node -e "
const fs=require('fs');
const p='${STATUS_JSON}';
let j={};
try{j=JSON.parse(fs.readFileSync(p));}catch{}
j.lastRestartAt=new Date().toISOString();
j.lastRestartReason='${reason}';
j.restartCountTotal=(j.restartCountTotal||0)+1;
j.restartHistory=(Array.isArray(j.restartHistory)?j.restartHistory:[]).concat([new Date().toISOString()]).slice(-100);
j.circuitBreakerEscalation=false;
fs.writeFileSync(p,JSON.stringify(j,null,2));
" 2>/dev/null || true

  node "${CB_NODE}" after-watchdog-restart >/dev/null 2>&1 || true

  sleep 1
  rmdir "${LOCK_DIR}" 2>/dev/null || true
}

run_cycle() {
  local lr_age=-1 d_age=-1
  local lrun=0
  [[ -f "${LAST_RUN_PATH}" ]] && lr_age="$(iso_age_sec "${LAST_RUN_PATH}" writtenAt)"
  [[ -f "${DASH_JSON}" ]] && d_age="$(iso_age_sec "${DASH_JSON}" generatedAt)"
  loop_running && lrun=1

  local need=0
  local reason="none"
  if [[ "${lrun}" -eq 0 ]]; then need=1; reason="process_missing"; fi
  if [[ "${need}" -eq 0 ]] && [[ "${lr_age}" != "-1" ]] && awk -v a="${lr_age}" -v m="${MAX_LOOP_SILENCE_SEC}" 'BEGIN{exit !(a+0>m)}'; then
    need=1; reason="loop_heartbeat_stale"
  fi
  if [[ "${need}" -eq 0 ]] && [[ "${d_age}" != "-1" ]] && awk -v a="${d_age}" -v m="${MAX_DASH_SILENCE_SEC}" 'BEGIN{exit !(a+0>m)}'; then
    need=1; reason="dashboard_stale"
  fi

  local act="ok"
  [[ "${need}" -eq 1 ]] && act="restart"
  write_watchdog_status "${lrun}" "${lr_age}" "${d_age}" "${act}" "${reason}"

  if [[ "${need}" -eq 1 ]]; then
    restart_loop "${reason}"
  fi

  node -e "
const fs=require('fs');
const sup='${OPS_DIR}/supervisor_status.json';
if(!fs.existsSync(sup)) process.exit(0);
try {
  const j=JSON.parse(fs.readFileSync(sup,'utf8'));
  j.lastWatchdogCheckAt=new Date().toISOString();
  fs.writeFileSync(sup,JSON.stringify(j,null,2));
} catch {}
" 2>/dev/null || true

  log_line "cycle loop_running=${lrun} lastRunAgeSec=${lr_age} dashAgeSec=${d_age} action=${act}"
}

log_line "start poll=${POLL_SEC}s loop_max=${MAX_LOOP_SILENCE_SEC}s dash_max=${MAX_DASH_SILENCE_SEC}s cooldown=${COOLDOWN_SEC}s max_restart/h=${MAX_RESTARTS_HOUR} data_root=${NEUROPILOT_DATA_ROOT}"

if [[ "${ONE_SHOT}" == "1" ]]; then
  run_cycle
  exit 0
fi

while true; do
  run_cycle || log_line "WARN cycle error (continuing)"
  sleep "${POLL_SEC}"
done
