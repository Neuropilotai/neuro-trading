#!/usr/bin/env bash
# Lance le smoke Pass 1 du validation pack (voir VALIDATION_PACK.md).
# Usage:
#   cd neuropilot_trading_v2
#   ./engine/governance/run_validation_pack.sh
#   ./engine/governance/run_validation_pack.sh --skip-workspace-checks
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
exec node engine/governance/validationPackSmoke.js "$@"
