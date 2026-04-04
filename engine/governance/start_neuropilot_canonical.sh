#!/usr/bin/env bash
# Prop-firm supervisor launcher: core loop + watchdog + health loop + local HTTP dashboards.
# run_loop_auto.sh remains the canonical engine; this script only orchestrates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
export NEUROPILOT_WAVE1_SYMBOLS="${NEUROPILOT_WAVE1_SYMBOLS:-BTCUSDT,ETHUSDT}"
export NEUROPILOT_WAVE1_PAPER_SCALE_MODE="${NEUROPILOT_WAVE1_PAPER_SCALE_MODE:-1}"
export NEUROPILOT_WAVE1_FORCE_SIGNALS="${NEUROPILOT_WAVE1_FORCE_SIGNALS:-1}"
export NP_HTTP_PORT="${NP_HTTP_PORT:-8080}"

OPS_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR:-${REPO_ROOT}/ops-snapshot}"
LOG_DIR="${LOG_DIR:-logs}"
mkdir -p "${LOG_DIR}" "${OPS_DIR}"

PID_FILE="${LOG_DIR}/neuropilot_supervisor_stack.pids"
SUP_JSON="${OPS_DIR}/supervisor_status.json"
FORCE="${NP_CANONICAL_FORCE_RESTART:-0}"

START_LOOP="${NEUROPILOT_START_LOOP:-1}"
START_WATCH="${NEUROPILOT_START_WATCHDOG:-1}"
START_HTTP="${NEUROPILOT_START_HTTP:-1}"
START_HEALTH="${NEUROPILOT_START_HEALTH_LOOP:-1}"
START_REPLAY_POLICY="${NEUROPILOT_START_REPLAY_POLICY_LOOP:-1}"
OPEN_BROWSER="${NEUROPILOT_OPEN_BROWSER:-1}"
OPEN_LIVE_TERMINAL="${NEUROPILOT_OPEN_LIVE_TERMINAL:-1}"

echo "[start_neuropilot_canonical] repo=${REPO_ROOT}"
echo "[start_neuropilot_canonical] data_root=${NEUROPILOT_DATA_ROOT} http_port=${NP_HTTP_PORT}"

if [[ -n "${NP_SLACK_WEBHOOK_URL:-}" ]]; then _slack_hook=yes; else _slack_hook=no; fi
if [[ -n "${NP_TELEGRAM_BOT_TOKEN:-}" && -n "${NP_TELEGRAM_CHAT_ID:-}" ]]; then _tg_hook=yes; else _tg_hook=no; fi
echo "[start_neuropilot_canonical] alert hooks (presence only): slack=${_slack_hook} telegram=${_tg_hook}"

existing() {
  [[ -f "${PID_FILE}" ]] || return 1
  local any=0
  while IFS= read -r line; do
    [[ -z "${line}" ]] || [[ "${line}" =~ ^# ]] && continue
    local pid="${line##*=}"
    [[ -z "${pid}" ]] && continue
    if kill -0 "${pid}" 2>/dev/null; then any=1; fi
  done <"${PID_FILE}"
  [[ "${any}" -eq 1 ]]
}

if existing && [[ "${FORCE}" != "1" ]]; then
  echo "[start_neuropilot_canonical] WARN: supervisor stack may already be running (see ${PID_FILE}). Set NP_CANONICAL_FORCE_RESTART=1 to start anyway."
  exit 1
fi

: >"${PID_FILE}"

export REPO_ROOT="${REPO_ROOT}"
export SUP_JSON_PATH="${SUP_JSON}"
export NEUROPILOT_OPS_SNAPSHOT_DIR="${OPS_DIR}"
node -e "
const fs=require('fs');
const p=process.env.SUP_JSON_PATH;
const o={
  supervisorStatus:'RUNNING',
  startedAt:new Date().toISOString(),
  dataRoot:process.env.NEUROPILOT_DATA_ROOT||'',
  httpPort:parseInt(process.env.NP_HTTP_PORT||'8080',10),
  repoRoot:process.env.REPO_ROOT||'',
  pids:{},
  lastWatchdogCheckAt:null,
  lastHealthCheckAt:null,
  lastRestartAt:null,
  restartCount:0,
  alertTargetsConfigured:{
    slack:!!process.env.NP_SLACK_WEBHOOK_URL,
    telegram:!!(process.env.NP_TELEGRAM_BOT_TOKEN && process.env.NP_TELEGRAM_CHAT_ID),
  },
  circuitBreakerState:null,
  incidentMode:'normal',
  replayBoostPolicyLoopRunning:false,
  replayBoostPolicyLastBuildAt:null,
};
fs.mkdirSync(require('path').dirname(p),{recursive:true});
fs.writeFileSync(p,JSON.stringify(o,null,2));
"

if [[ "${START_HTTP}" == "1" ]]; then
  export NP_HTTP_KILL_EXISTING="${NP_HTTP_KILL_EXISTING:-1}"
  nohup bash "${SCRIPT_DIR}/serve_dashboard_local.sh" >>"${LOG_DIR}/http_server.outer.log" 2>&1 &
  echo "HTTP=$!" >>"${PID_FILE}"
  echo "[start_neuropilot_canonical] HTTP PID=$! port=${NP_HTTP_PORT}"
  node -e "
const fs=require('fs');
const path='${OPS_DIR}/http_server_status.json';
const o={generatedAt:new Date().toISOString(),mode:'running',shellPid:parseInt(process.argv[1],10),port:parseInt(process.env.NP_HTTP_PORT||'8080',10),documentRoot:process.env.REPO_ROOT||''};
fs.writeFileSync(path,JSON.stringify(o,null,2));
" "$!" 2>/dev/null || true
else
  echo "[start_neuropilot_canonical] skip HTTP"
fi

if [[ "${START_LOOP}" == "1" ]]; then
  nohup bash "${REPO_ROOT}/engine/governance/run_loop_auto.sh" >>"${LOG_DIR}/run_loop_auto.outer.log" 2>&1 &
  echo "LOOP=$!" >>"${PID_FILE}"
  echo "[start_neuropilot_canonical] run_loop_auto PID=$!"
else
  echo "[start_neuropilot_canonical] skip loop"
fi

if [[ "${START_WATCH}" == "1" ]]; then
  nohup bash "${SCRIPT_DIR}/watchdog_neuropilot.sh" >>"${LOG_DIR}/watchdog_neuropilot.outer.log" 2>&1 &
  echo "WATCHDOG=$!" >>"${PID_FILE}"
  echo "[start_neuropilot_canonical] watchdog PID=$!"
else
  echo "[start_neuropilot_canonical] skip watchdog"
fi

if [[ "${START_HEALTH}" == "1" ]]; then
  nohup bash "${SCRIPT_DIR}/run_health_monitor_loop.sh" >>"${LOG_DIR}/health_monitor_loop.outer.log" 2>&1 &
  echo "HEALTH_LOOP=$!" >>"${PID_FILE}"
  echo "[start_neuropilot_canonical] health_monitor_loop PID=$!"
else
  echo "[start_neuropilot_canonical] skip health loop"
fi

if [[ "${START_REPLAY_POLICY}" == "1" ]]; then
  export NEUROPILOT_DATA_ROOT
  export NEUROPILOT_OPS_SNAPSHOT_DIR="${OPS_DIR}"
  nohup bash "${SCRIPT_DIR}/run_replay_boost_policy_loop.sh" >>"${LOG_DIR}/replay_boost_policy_loop.outer.log" 2>&1 &
  echo "REPLAY_POLICY=$!" >>"${PID_FILE}"
  echo "[start_neuropilot_canonical] replay_boost_policy_loop PID=$!"
else
  echo "[start_neuropilot_canonical] skip replay boost policy loop"
fi

GOV_URL="http://127.0.0.1:${NP_HTTP_PORT}/ops-snapshot/governance_dashboard.html"
OWNER_URL="http://127.0.0.1:${NP_HTTP_PORT}/ops-snapshot/owner_ops_dashboard.html"
echo "[start_neuropilot_canonical] governance URL: ${GOV_URL}"
if [[ -f "${OPS_DIR}/owner_ops_dashboard.html" ]]; then
  echo "[start_neuropilot_canonical] owner ops URL: ${OWNER_URL}"
else
  echo "[start_neuropilot_canonical] note: owner_ops_dashboard.html not found — skipping second URL"
fi

if [[ "${OPEN_BROWSER}" == "1" ]] && command -v open >/dev/null 2>&1; then
  open "${GOV_URL}" 2>/dev/null || true
  [[ -f "${OPS_DIR}/owner_ops_dashboard.html" ]] && open "${OWNER_URL}" 2>/dev/null || true
fi

echo ""
echo "[start_neuropilot_canonical] Live monitoring (copy/paste):"
echo "  bash ${REPO_ROOT}/logs/live_supervisor_watch.sh"
echo "  tail -f ${REPO_ROOT}/logs/run_loop_auto.log"
echo "  tail -f ${REPO_ROOT}/ops-snapshot/neuropilot_health.md"
echo ""

WATCH_SH="${LOG_DIR}/live_supervisor_watch.sh"
cat >"${WATCH_SH}" <<EOF
#!/usr/bin/env bash
set +e
export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT}"
REPO_ROOT="${REPO_ROOT}"
OPS="\${REPO_ROOT}/ops-snapshot"
GOV="\${NEUROPILOT_DATA_ROOT}/governance"
while true; do
  clear
  date -u
  echo "=== OPERATOR_LOOP_STATUS (tail log) ==="
  grep OPERATOR_LOOP_STATUS "\${REPO_ROOT}/logs/run_loop_auto.log" 2>/dev/null | tail -5 || true
  echo ""
  echo "=== paper_exec_v1_last_run ==="
  if command -v jq >/dev/null 2>&1 && [[ -f "\${GOV}/paper_exec_v1_last_run.json" ]]; then
    jq '{writtenAt,effectiveAppended,duplicateSkippedPersistent}' "\${GOV}/paper_exec_v1_last_run.json" 2>/dev/null
  else
    echo "(missing jq or last_run json)"
  fi
  echo ""
  echo "=== strict mapping overlap ==="
  if command -v jq >/dev/null 2>&1 && [[ -f "\${GOV}/paper_trades_strict_mapping_report.json" ]]; then
    jq '{generatedAt,overlapCount,promotedUniverseCount}' "\${GOV}/paper_trades_strict_mapping_report.json" 2>/dev/null
  else
    echo "(missing report)"
  fi
  echo ""
  echo "=== supervisor health / breaker ==="
  if command -v jq >/dev/null 2>&1 && [[ -f "\${OPS}/neuropilot_health.json" ]]; then
    jq '{overallStatus,incidentMode,circuitBreakerActive,incidentFingerprint}' "\${OPS}/neuropilot_health.json" 2>/dev/null
  else
    echo "(health json not ready yet)"
  fi
  if command -v jq >/dev/null 2>&1 && [[ -f "\${OPS}/circuit_breaker_status.json" ]]; then
    jq '{state,reason,updatedAt}' "\${OPS}/circuit_breaker_status.json" 2>/dev/null
  fi
  echo ""
  echo "=== governance_dashboard dataRoot hint ==="
  if command -v jq >/dev/null 2>&1 && [[ -f "\${OPS}/governance_dashboard.json" ]]; then
    jq '{generatedAt,dataRoot}' "\${OPS}/governance_dashboard.json" 2>/dev/null
  fi
  sleep 10
done
EOF
chmod +x "${WATCH_SH}"

if [[ "${OPEN_LIVE_TERMINAL}" == "1" ]] && command -v osascript >/dev/null 2>&1; then
  _watch_esc="$(printf '%q' "${WATCH_SH}")"
  osascript -e "tell application \"Terminal\" to do script \"${_watch_esc}\"" 2>/dev/null || true
elif [[ "${OPEN_LIVE_TERMINAL}" == "1" ]]; then
  echo "[start_neuropilot_canonical] osascript not available — run: bash ${WATCH_SH}"
fi

export PID_FILE_PATH="${PID_FILE}"
export OPS_DIR_MERGE="${OPS_DIR}"
export DATA_ROOT_MERGE="${NEUROPILOT_DATA_ROOT}"
bash "${SCRIPT_DIR}/monitor_neuropilot_health.sh" >>"${LOG_DIR}/monitor_neuropilot_health.startup.log" 2>&1 || true
node "${SCRIPT_DIR}/circuitBreakerNeuropilotCore.js" evaluate >>"${LOG_DIR}/circuit_breaker.startup.log" 2>&1 || true

node -e "
const fs=require('fs');
const path=require('path');
const sup=process.env.SUP_JSON_PATH;
const pf=process.env.PID_FILE_PATH;
const ops=process.env.OPS_DIR_MERGE;
const dr=process.env.DATA_ROOT_MERGE||'';
const raw=fs.readFileSync(pf,'utf8');
const pids={};
for (const line of raw.split(/\n')) {
  const m=String(line).match(/^([A-Za-z_]+)=(\d+)/);
  if (m) pids[m[1]]=parseInt(m[2],10);
}
const j=JSON.parse(fs.readFileSync(sup,'utf8'));
j.pids=pids;
j.replayBoostPolicyLoopRunning=Boolean(pids.REPLAY_POLICY);
try {
  const cb=JSON.parse(fs.readFileSync(path.join(ops,'circuit_breaker_status.json'),'utf8'));
  j.circuitBreakerState=cb.state||null;
} catch {}
try {
  const h=JSON.parse(fs.readFileSync(path.join(ops,'neuropilot_health.json'),'utf8'));
  j.lastHealthCheckAt=new Date().toISOString();
  j.lastOverallHealthStatus=h.overallStatus||null;
  j.incidentMode=h.incidentMode||j.incidentMode||'normal';
} catch {}
try {
  const rp=JSON.parse(fs.readFileSync(path.join(dr,'governance','replay_boost_policy.json'),'utf8'));
  j.replayBoostPolicyLastBuildAt=rp.generatedAt||null;
} catch {}
fs.writeFileSync(sup,JSON.stringify(j,null,2));
" 2>/dev/null || true

cp -f "${PID_FILE}" "${LOG_DIR}/canonical_stack.pids" 2>/dev/null || true

echo "[start_neuropilot_canonical] pids → ${PID_FILE} (mirror: ${LOG_DIR}/canonical_stack.pids)"
echo "[start_neuropilot_canonical] status → ${SUP_JSON}"
echo "[start_neuropilot_canonical] live watch → ${WATCH_SH}"
echo "[start_neuropilot_canonical] stop: npm run governance:stop-canonical"
