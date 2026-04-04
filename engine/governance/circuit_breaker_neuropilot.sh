#!/usr/bin/env bash
# Circuit breaker (supervision-only). Thin wrapper around circuitBreakerNeuropilotCore.js
#
# Commands:
#   status | evaluate | is-restart-allowed | set-state CLOSED|OPEN|HALF_OPEN [reason]
#   mark-half-open-restart-used | after-watchdog-restart
#
# Env: NEUROPILOT_OPS_SNAPSHOT_DIR, NP_CIRCUIT_BREAKER_*, NP_FORCE_CIRCUIT_BREAKER_OPEN

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

export NEUROPILOT_OPS_SNAPSHOT_DIR="${NEUROPILOT_OPS_SNAPSHOT_DIR:-${REPO_ROOT}/ops-snapshot}"

exec node "${SCRIPT_DIR}/circuitBreakerNeuropilotCore.js" "$@"
