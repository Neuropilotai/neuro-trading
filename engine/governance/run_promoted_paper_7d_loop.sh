#!/usr/bin/env bash
set -euo pipefail

# Canonical operator loop for promoted -> paper 7d coverage.
# Purpose:
# - run paper execution with promoted replay + recent market align
# - refresh strict mapping
# - read checkpoint
# - append convergence trend
# - refresh ops snapshot/dashboard
#
# Usage:
#   bash engine/governance/run_promoted_paper_7d_loop.sh
#
# Optional env overrides:
#   NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
#   NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_PER_RUN=20
#   NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_SETUPS_PER_RUN=5
#   NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_BARS_PER_SETUP=3
#
# Notes:
# - Must be launched from repo root or any subdir inside the repo.
# - Exits on first command failure.
# - Does not change live/promo/evolution behavior beyond existing paper replay settings.
#
# Final OPERATOR_LOOP_STATUS (after trend + export):
#   HEALTHY_PROGRESS — delta_promoted_and_paper_recent > 0, or full 7d coverage (not_seen == 0 and recent > 0)
#   STABLE_OK        — checkpoint OK with partial not_seen, or remaining OK paths
#   STAGNATING       — NO_PROGRESS, BYPASS_ACTIVE_WAITING, or BYPASS_OFF
#   REGRESSION       — checkpoint REGRESSION, stale strict mapping vs last run, or missing artefacts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
export NEUROPILOT_PAPER_EXEC_V1="${NEUROPILOT_PAPER_EXEC_V1:-1}"
export NEUROPILOT_PAPER_ALLOW_PROMOTED_REPLAY="${NEUROPILOT_PAPER_ALLOW_PROMOTED_REPLAY:-1}"
export NEUROPILOT_PAPER_PROMOTED_REPLAY_SMART_ONLY="${NEUROPILOT_PAPER_PROMOTED_REPLAY_SMART_ONLY:-1}"
export NEUROPILOT_PAPER_PROMOTED_REPLAY_REQUIRE_NOT_SEEN_7D="${NEUROPILOT_PAPER_PROMOTED_REPLAY_REQUIRE_NOT_SEEN_7D:-1}"
export NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_PER_RUN="${NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_PER_RUN:-20}"
export NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_SETUPS_PER_RUN="${NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_SETUPS_PER_RUN:-5}"
export NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_BARS_PER_SETUP="${NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_BARS_PER_SETUP:-3}"
export NEUROPILOT_PAPER_PROMOTED_RECENT_MARKET_ALIGN="${NEUROPILOT_PAPER_PROMOTED_RECENT_MARKET_ALIGN:-1}"

LAST_RUN_PATH="${NEUROPILOT_DATA_ROOT}/governance/paper_exec_v1_last_run.json"
STRICT_REPORT_PATH="${NEUROPILOT_DATA_ROOT}/governance/paper_trades_strict_mapping_report.json"
ANALYSIS_PATH="${NEUROPILOT_DATA_ROOT}/governance/paper_trades_by_setup_analysis.json"

echo "== Repo root =="
echo "${REPO_ROOT}"
echo
echo "== Data root =="
echo "${NEUROPILOT_DATA_ROOT}"
echo
echo "== Effective env =="
echo "NEUROPILOT_PAPER_EXEC_V1=${NEUROPILOT_PAPER_EXEC_V1}"
echo "NEUROPILOT_PAPER_ALLOW_PROMOTED_REPLAY=${NEUROPILOT_PAPER_ALLOW_PROMOTED_REPLAY}"
echo "NEUROPILOT_PAPER_PROMOTED_REPLAY_SMART_ONLY=${NEUROPILOT_PAPER_PROMOTED_REPLAY_SMART_ONLY}"
echo "NEUROPILOT_PAPER_PROMOTED_REPLAY_REQUIRE_NOT_SEEN_7D=${NEUROPILOT_PAPER_PROMOTED_REPLAY_REQUIRE_NOT_SEEN_7D}"
echo "NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_PER_RUN=${NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_PER_RUN}"
echo "NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_SETUPS_PER_RUN=${NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_SETUPS_PER_RUN}"
echo "NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_BARS_PER_SETUP=${NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_BARS_PER_SETUP}"
echo "NEUROPILOT_PAPER_PROMOTED_RECENT_MARKET_ALIGN=${NEUROPILOT_PAPER_PROMOTED_RECENT_MARKET_ALIGN}"
echo

echo "== Step 1/6: run paper execution =="
node engine/governance/runPaperExecutionV1.js
echo

echo "== Step 2/6: verify last run fields =="
if [[ -f "${LAST_RUN_PATH}" ]]; then
  jq '{
    writtenAt,
    effectiveAppended,
    duplicateSkippedPersistent,
    promotedReplayBypassEnabled,
    promotedReplayBypassCount,
    promotedReplayMaxPerRun,
    promotedReplayRecentMarketAlignEnabled,
    promotedReplayRecentAlignmentCount
  }' "${LAST_RUN_PATH}"
else
  echo "ERROR: last run file not found: ${LAST_RUN_PATH}" >&2
  exit 1
fi
echo

echo "== Step 3/6: refresh strict mapping =="
npm run analyze:paper-by-setup
echo

echo "== Step 4/6: checkpoint =="
npm run governance:promoted-recent-checkpoint -- --json
echo

echo "== Step 5/6: append convergence trend =="
npm run governance:promoted-convergence-trend
echo

echo "== Step 6/6: refresh ops snapshot/dashboard =="
node engine/evolution/scripts/exportOpsSnapshot.js
echo

echo "== Final quick summary =="
if [[ -f "${STRICT_REPORT_PATH}" ]]; then
  jq '{
    promoted_and_paper_recent: (.promoted_and_paper_recent | length),
    promoted_not_seen_in_paper_last_7d: (.promoted_not_seen_in_paper_last_7d | length),
    promoted_and_paper_recent_by_simulatedAt: (
      if (.promoted_and_paper_recent_by_simulatedAt | type) == "array"
      then (.promoted_and_paper_recent_by_simulatedAt | length)
      else (.promoted_and_paper_recent_by_simulatedAt.count // 0)
      end
    )
  }' "${STRICT_REPORT_PATH}"
else
  echo "WARN: strict report not found: ${STRICT_REPORT_PATH}" >&2
fi
echo

if [[ -f "${ANALYSIS_PATH}" ]]; then
  echo "== Join diagnostics (recent_7d) =="
  jq '.joinDiagnostics.recent_7d' "${ANALYSIS_PATH}"
else
  echo "WARN: analysis file not found: ${ANALYSIS_PATH}" >&2
fi
echo

# Re-read checkpoint after trend + export so delta_promoted_and_paper_recent includes this run's trend line.
echo "== Operator loop status (one line) =="
CHECKPOINT_JSON="$(node engine/governance/checkPromotedRecentCheckpoint.js --json)"
OPERATOR_LOOP_STATUS="$(echo "${CHECKPOINT_JSON}" | jq -r '
  . as $c
  | ($c.verdict) as $v
  | ($c.strictMappingStaleVsLastRun == true) as $stale
  | ($c.metrics.promoted_and_paper_recent_count // 0) as $r
  | ($c.metrics.promoted_not_seen_in_paper_last_7d_count // 0) as $ns
  | ($c.trend.delta_promoted_and_paper_recent) as $d
  | if ($v == "REGRESSION") or $stale or ($v == "MISSING_STRICT_MAPPING") or ($v == "MISSING_LAST_RUN") then
      "REGRESSION"
    elif (($d != null) and ($d > 0)) or (($ns == 0) and ($r > 0)) then
      "HEALTHY_PROGRESS"
    elif ($v == "NO_PROGRESS") or ($v == "BYPASS_ACTIVE_WAITING") or ($v == "BYPASS_OFF") then
      "STAGNATING"
    elif ($v == "OK") and ($ns > 0) then
      "STABLE_OK"
    elif $v == "OK" then
      "STABLE_OK"
    else
      "STABLE_OK"
    end
')"
echo "OPERATOR_LOOP_STATUS=${OPERATOR_LOOP_STATUS}"
echo "${CHECKPOINT_JSON}" | jq -c --arg os "${OPERATOR_LOOP_STATUS}" '{
  verdict,
  strictMappingStaleVsLastRun,
  operatorStatus: $os,
  promoted_and_paper_recent: .metrics.promoted_and_paper_recent_count,
  promoted_not_seen_in_paper_last_7d: .metrics.promoted_not_seen_in_paper_last_7d_count,
  delta_promoted_and_paper_recent: .trend.delta_promoted_and_paper_recent
}'
echo
echo "Status legend: HEALTHY_PROGRESS (overlap improving or full 7d coverage) | STABLE_OK (OK but partial not_seen) | STAGNATING (no overlap progress / waiting / bypass off) | REGRESSION (checkpoint regression, stale strict mapping, or missing artefacts)"

echo "== Done =="
echo "Rule of thumb:"
echo "- If promoted_not_seen_in_paper_last_7d goes down, the loop is healthy."
echo "- If promoted_and_paper_recent holds or rises, convergence is improving."
echo "- If both stagnate for multiple cycles, audit the remaining setup keys."
