#!/usr/bin/env bash
# Local HTTP server for ops-snapshot dashboards (repo root as document root).
#
# Env:
#   NP_HTTP_PORT (default 8080)
#   NP_HTTP_KILL_EXISTING=1  — kill listener on port before start (macOS: lsof)
#   NEUROPILOT_OPS_SNAPSHOT_DIR — unused; always serves from REPO_ROOT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

PORT="${NP_HTTP_PORT:-8080}"
KILL_EXISTING="${NP_HTTP_KILL_EXISTING:-0}"
LOG_DIR="${LOG_DIR:-logs}"
OPS_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR:-${REPO_ROOT}/ops-snapshot}"
mkdir -p "${LOG_DIR}" "${OPS_DIR}"
HTTP_LOG="${LOG_DIR}/http_server.out"
STATUS_JSON="${OPS_DIR}/http_server_status.json"

echo "[serve_dashboard_local] repo=${REPO_ROOT} port=${PORT}"

if [[ "${KILL_EXISTING}" == "1" ]] && command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -ti ":${PORT}" 2>/dev/null); do
    echo "[serve_dashboard_local] killing PID ${pid} on port ${PORT}"
    kill "${pid}" 2>/dev/null || true
  done
  sleep 1
fi

node -e "
const fs=require('fs');
const path='${STATUS_JSON}';
const o={
  generatedAt:new Date().toISOString(),
  mode:'starting',
  port:${PORT},
  documentRoot:'${REPO_ROOT}',
  urlGovernance:'http://127.0.0.1:${PORT}/ops-snapshot/governance_dashboard.html',
  urlOwnerOps:'http://127.0.0.1:${PORT}/ops-snapshot/owner_ops_dashboard.html',
};
fs.writeFileSync(path,JSON.stringify(o,null,2));
"

echo "[serve_dashboard_local] serving ${REPO_ROOT} — dashboards under /ops-snapshot/"
echo "[serve_dashboard_local] log ${HTTP_LOG}"

python3 -m http.server "${PORT}" >>"${HTTP_LOG}" 2>&1

