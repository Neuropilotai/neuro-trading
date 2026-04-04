#!/usr/bin/env bash
# Optional Slack / Telegram alerts + local log. Never prints tokens.
#
# Usage:
#   bash send_neuropilot_alert.sh --severity info|warn|critical --title "..." --message "..." \
#     [--fingerprint fp] [--context-json /path/to.json]
#
# Env:
#   NP_SLACK_WEBHOOK_URL
#   NP_TELEGRAM_BOT_TOKEN + NP_TELEGRAM_CHAT_ID
#   NP_ALERT_MIN_INTERVAL_SEC (default 300) — per fingerprint dedupe
#   NEUROPILOT_OPS_SNAPSHOT_DIR

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

OPS_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR:-${REPO_ROOT}/ops-snapshot}"
LOG_DIR="${LOG_DIR:-logs}"
mkdir -p "${LOG_DIR}" "${OPS_DIR}"

ALERT_LOG="${LOG_DIR}/alerts_neuropilot.log"
STATE_JSON="${OPS_DIR}/alert_state.json"
MIN_INTERVAL="${NP_ALERT_MIN_INTERVAL_SEC:-300}"

SEVERITY=""
TITLE=""
MESSAGE=""
FINGERPRINT="default"
CONTEXT_JSON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --severity) SEVERITY="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --message) MESSAGE="${2:-}"; shift 2 ;;
    --fingerprint) FINGERPRINT="${2:-}"; shift 2 ;;
    --context-json) CONTEXT_JSON="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

if [[ -z "${SEVERITY}" ]] || [[ -z "${TITLE}" ]] || [[ -z "${MESSAGE}" ]]; then
  echo "[send_neuropilot_alert] ERROR: need --severity --title --message" >&2
  exit 2
fi

log_local() {
  echo "[send_neuropilot_alert $(ts)] severity=${SEVERITY} fp=${FINGERPRINT} title=${TITLE} msg=${MESSAGE:0:200}" | tee -a "${ALERT_LOG}"
}

rate_ok() {
  node -e "
const fs=require('fs');
const statePath='${STATE_JSON}';
const fp='${FINGERPRINT}';
const minSec=${MIN_INTERVAL};
let state={};
try { if(fs.existsSync(statePath)) state=JSON.parse(fs.readFileSync(statePath,'utf8')); } catch {}
const last=state.lastByFingerprint&&state.lastByFingerprint[fp];
const t=last?Date.parse(last):0;
const ok=!Number.isFinite(t)||(Date.now()-t)/1000>=minSec;
if(ok){
  state.lastByFingerprint=state.lastByFingerprint||{};
  state.lastByFingerprint[fp]=new Date().toISOString();
  state.lastAlertSentAt=state.lastByFingerprint[fp];
  fs.mkdirSync(require('path').dirname(statePath),{recursive:true});
  fs.writeFileSync(statePath,JSON.stringify(state,null,2));
}
process.stdout.write(ok?'1':'0');
" 2>/dev/null || echo "0"
}

SLACK_URL="${NP_SLACK_WEBHOOK_URL:-}"
TG_TOKEN="${NP_TELEGRAM_BOT_TOKEN:-}"
TG_CHAT="${NP_TELEGRAM_CHAT_ID:-}"

SLACK_CFG=0
[[ -n "${SLACK_URL}" ]] && SLACK_CFG=1
TG_CFG=0
[[ -n "${TG_TOKEN}" && -n "${TG_CHAT}" ]] && TG_CFG=1

log_local

if [[ "${SEVERITY}" == "info" ]]; then
  echo "[send_neuropilot_alert] info: hooks skipped by policy (log only)" | tee -a "${ALERT_LOG}"
  exit 0
fi

_ro="$(rate_ok)"
if [[ "${_ro}" != "1" ]]; then
  echo "[send_neuropilot_alert] rate-limit skip fingerprint=${FINGERPRINT}" | tee -a "${ALERT_LOG}"
  exit 0
fi

BODY="[${SEVERITY}] ${TITLE}
${MESSAGE}"

post_slack() {
  [[ "${SLACK_CFG}" -eq 1 ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  local payload
  payload="$(node -e "
const t=process.argv[1];
console.log(JSON.stringify({text:t}));
" "${BODY}")"
  if ! curl -sS -X POST -H 'Content-type: application/json' --data "${payload}" "${SLACK_URL}" >/dev/null 2>&1; then
    echo "[send_neuropilot_alert] WARN slack post failed (no secret logged)" | tee -a "${ALERT_LOG}"
  fi
}

post_telegram() {
  [[ "${TG_CFG}" -eq 1 ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  local url="https://api.telegram.org/bot${TG_TOKEN}/sendMessage"
  if ! curl -sS -X POST "${url}" \
    -d "chat_id=${TG_CHAT}" \
    --data-urlencode "text=${BODY}" >/dev/null 2>&1; then
    echo "[send_neuropilot_alert] WARN telegram post failed" | tee -a "${ALERT_LOG}"
  fi
}

if [[ "${SEVERITY}" == "warn" ]] || [[ "${SEVERITY}" == "critical" ]]; then
  if [[ "${SLACK_CFG}" -eq 0 && "${TG_CFG}" -eq 0 ]]; then
    echo "[send_neuropilot_alert] WARN no Slack/Telegram env configured — local log only" | tee -a "${ALERT_LOG}"
  fi
  post_slack
  post_telegram
  if [[ "${SEVERITY}" == "critical" ]]; then
    sleep 2
    post_slack
  fi
fi

exit 0
