#!/usr/bin/env bash
# Periodic heartbeat check for com.neuropilot.smartloop.watchdog (launchd StartInterval).
# If the smart-loop main process freezes, KeepAlive does not help; this job SIGTERMs it
# so the main agent can restart. Reads $NEUROPILOT_DATA_ROOT/loop_logs/ (not repo ./loop_logs).
#
# Install: see com.neuropilot.smartloop.watchdog.plist and comments in run-smartloop.sh
set -uo pipefail

_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_smartloop_watchdog_common.sh
source "$_HERE/_smartloop_watchdog_common.sh"

PROJECT_ROOT="/Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2"
export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"

DATA_ROOT="$NEUROPILOT_DATA_ROOT"
HEARTBEAT_FILE="$DATA_ROOT/loop_logs/heartbeat.log"
LAST_PROGRESS_FILE="$DATA_ROOT/loop_logs/last_progress.ts"
LOCK_DIR="$DATA_ROOT/.smart_loop_lock"
COOLDOWN_FILE="$DATA_ROOT/.watchdog_last_kill"
STALE_SEC="${NEUROPILOT_SMART_LOOP_STALE_SEC:-7200}"
COOLDOWN_SEC="${NEUROPILOT_SMART_LOOP_WATCHDOG_COOLDOWN_SEC:-300}"

log_line() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] SMARTLOOP_WATCHDOG $*"
}

mkdir -p "$DATA_ROOT/loop_logs"

NOW_TS=$(date -u +%s)

if [[ -f "$COOLDOWN_FILE" ]]; then
  IFS= read -r LAST_KILL < "$COOLDOWN_FILE" || LAST_KILL=""
  if [[ "$LAST_KILL" =~ ^[0-9]+$ ]] && (( NOW_TS - LAST_KILL < COOLDOWN_SEC )); then
    log_line "skip cooldown_active last_kill_age_sec=$((NOW_TS - LAST_KILL)) threshold=${COOLDOWN_SEC}"
    exit 0
  fi
fi

if [[ ! -f "$HEARTBEAT_FILE" ]] || [[ ! -s "$HEARTBEAT_FILE" ]]; then
  log_line "skip no_heartbeat_file"
  exit 0
fi

LAST_LINE="$(tail -n 1 "$HEARTBEAT_FILE" 2>/dev/null || true)"
LAST_TS="${LAST_LINE%% *}"
if [[ -z "$LAST_TS" ]]; then
  log_line "skip empty_timestamp"
  exit 0
fi

LAST_TS_SEC=$(date -jf "%Y-%m-%dT%H:%M:%SZ" "$LAST_TS" +%s 2>/dev/null) || true

if ! [[ "$LAST_TS_SEC" =~ ^[0-9]+$ ]]; then
  log_line "skip bad_timestamp_parse last_ts=$LAST_TS"
  exit 0
fi

AGE=$((NOW_TS - LAST_TS_SEC))
if (( AGE <= STALE_SEC )); then
  log_line "ok age_sec=$AGE threshold=$STALE_SEC"
  exit 0
fi

if neuropilot_heartbeat_mtime_fresh "$HEARTBEAT_FILE" "$NOW_TS" "$STALE_SEC"; then
  LAST_WRITE=$(stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
  [[ "$LAST_WRITE" =~ ^[0-9]+$ ]] || LAST_WRITE=0
  log_line "skip file_activity_detected mtime_age_sec=$((NOW_TS - LAST_WRITE)) threshold=$STALE_SEC last_ts=$LAST_TS line_age_sec=$AGE"
  exit 0
fi

if neuropilot_last_progress_ts_fresh "$LAST_PROGRESS_FILE" "$NOW_TS" "$STALE_SEC"; then
  IFS= read -r _lp < "$LAST_PROGRESS_FILE" || _lp=0
  [[ "$_lp" =~ ^[0-9]+$ ]] || _lp=0
  log_line "skip progress_ts_fresh file=$LAST_PROGRESS_FILE progress_ts=${_lp} progress_age_sec=$((NOW_TS - _lp)) threshold=$STALE_SEC last_ts=$LAST_TS line_age_sec=$AGE $(neuropilot_pipeline_progress_log_suffix "$HEARTBEAT_FILE")"
  exit 0
fi

if neuropilot_smart_loop_cpu_active; then
  log_line "stale_heartbeat_but_active skip_kill last_ts=$LAST_TS age_sec=$AGE (cpu>0 on run-smart-evolution-loop)"
  exit 0
fi

log_line "stale_heartbeat last_ts=$LAST_TS age_sec=$AGE threshold=$STALE_SEC action=sigterm_smart_loop"

terminate_smart_loop_procs() {
  local pid
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done < <(pgrep -f "run-smart-evolution-loop\\.sh" 2>/dev/null || true)
}

terminate_smart_loop_procs
sleep 3
neuropilot_remove_smart_loop_lock "$DATA_ROOT" "watchdog_stale_heartbeat"
printf '%s\n' "$NOW_TS" > "$COOLDOWN_FILE"
log_line "recovery lock_cleared=${LOCK_DIR} cooldown_written=1"

exit 0
