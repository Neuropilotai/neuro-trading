#!/usr/bin/env bash
# Minimal wrapper: paper chain (data engine → Wave1 signals → paper execution V1).
# Requires NEUROPILOT_DATA_ROOT; optional NEUROPILOT_WAVE1_SYMBOLS (else derived from governance/paper_execution_v1_signals.json).
set -euo pipefail
if [[ -z "${NEUROPILOT_DATA_ROOT:-}" ]]; then
  echo "runPaperDataRefreshChain.sh: set NEUROPILOT_DATA_ROOT" >&2
  exit 1
fi
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$ROOT_DIR/engine/governance/runPaperDataRefreshChain.js" "$@"
