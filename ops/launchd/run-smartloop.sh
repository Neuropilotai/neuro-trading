#!/usr/bin/env bash
# LaunchAgent entry for macOS: com.neuropilot.smartloop
#
# Supervises ONLY run-smart-evolution-loop.sh (not Meta or full pipeline alone).
# launchd KeepAlive restarts this wrapper if the process exits; ThrottleInterval in the plist avoids tight respawn loops.
#
# Install (user LaunchAgents):
#   cp ops/launchd/com.neuropilot.smartloop.plist ~/Library/LaunchAgents/
#   cp ops/launchd/com.neuropilot.smartloop.watchdog.plist ~/Library/LaunchAgents/
#   launchctl unload ~/Library/LaunchAgents/com.neuropilot.smartloop.plist 2>/dev/null || true
#   launchctl unload ~/Library/LaunchAgents/com.neuropilot.smartloop.watchdog.plist 2>/dev/null || true
#   launchctl load ~/Library/LaunchAgents/com.neuropilot.smartloop.watchdog.plist
#   launchctl load ~/Library/LaunchAgents/com.neuropilot.smartloop.plist
#
# Logs (also tee'd by smart-loop into $NEUROPILOT_DATA_ROOT/loop_logs/):
#   logs/smartloop.out.log
#   logs/smartloop.err.log
#
# Heartbeat: $NEUROPILOT_DATA_ROOT/loop_logs/heartbeat.log (not repo ./loop_logs; tail -f "$NEUROPILOT_DATA_ROOT/loop_logs/heartbeat.log").
# Cooldown file (shared with watchdog): $NEUROPILOT_DATA_ROOT/.watchdog_last_kill
# Stale detection: NEUROPILOT_SMART_LOOP_STALE_SEC (default 7200). Shorter values risk false positives
# when a single full pipeline exceeds the threshold.
# Cooldown: NEUROPILOT_SMART_LOOP_WATCHDOG_COOLDOWN_SEC (default 300) avoids kill loops after recovery.
# Before SIGTERM on stale heartbeat, watchdog + wrapper skip if: heartbeat mtime fresh, last_progress.ts epoch fresh, or CPU>0
# (see _smartloop_watchdog_common.sh). Mtime uses macOS stat -f %m. last_progress.ts is written by runFullPipelineExpanded.sh.
# Lock removals append to loop_logs/lock_events.log.
# Pre-corr meta env vars are set in com.neuropilot.smartloop.plist (override there or in .env).
set -euo pipefail

PROJECT_ROOT="/Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2"
cd "$PROJECT_ROOT"
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_smartloop_watchdog_common.sh
source "$_HERE/_smartloop_watchdog_common.sh"

mkdir -p "$PROJECT_ROOT/logs"

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
# Smart loop must continue discovery even if run_health marks critical datasets degraded.
export NEUROPILOT_DATA_GUARD_SKIP="${NEUROPILOT_DATA_GUARD_SKIP:-0}"

DATA_ROOT="$NEUROPILOT_DATA_ROOT"
LOCK_DIR="$DATA_ROOT/.smart_loop_lock"
HEARTBEAT_FILE="$DATA_ROOT/loop_logs/heartbeat.log"
LAST_PROGRESS_FILE="$DATA_ROOT/loop_logs/last_progress.ts"
COOLDOWN_FILE="$DATA_ROOT/.watchdog_last_kill"
# Max seconds without a new heartbeat line before we treat the loop as stuck.
# Default 7200 (2h): full pipeline runs can exceed 30–60 min; avoid false positives.
STALE_SEC="${NEUROPILOT_SMART_LOOP_STALE_SEC:-7200}"
# After a SIGTERM recovery, avoid immediate re-kill (watchdog + wrapper share this file).
COOLDOWN_SEC="${NEUROPILOT_SMART_LOOP_WATCHDOG_COOLDOWN_SEC:-300}"

mkdir -p "$DATA_ROOT/loop_logs"

# SIGTERM only explicit PIDs from pgrep (numeric), not broad pkill -f.
terminate_smart_loop_procs() {
  local pid
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done < <(pgrep -f "run-smart-evolution-loop\\.sh" 2>/dev/null || true)
}

# Best-effort recovery before start: stale heartbeat → try to stop orphaned loop and clear lock.
# Note: launchd will not restart a frozen job by itself; this helps after manual kickstart or if the wrapper is re-invoked.
if [[ -f "$HEARTBEAT_FILE" ]] && [[ -s "$HEARTBEAT_FILE" ]]; then
  LAST_LINE="$(tail -n 1 "$HEARTBEAT_FILE" 2>/dev/null || true)"
  LAST_TS="${LAST_LINE%% *}"
  if [[ -n "$LAST_TS" ]]; then
    NOW_TS=$(date -u +%s)
    LAST_TS_SEC=$(date -jf "%Y-%m-%dT%H:%M:%SZ" "$LAST_TS" +%s 2>/dev/null) || true
    if [[ "$LAST_TS_SEC" =~ ^[0-9]+$ ]] && (( NOW_TS - LAST_TS_SEC > STALE_SEC )); then
      DO_KILL=1
      if [[ -f "$COOLDOWN_FILE" ]]; then
        IFS= read -r LAST_KILL < "$COOLDOWN_FILE" || LAST_KILL=""
        if [[ "$LAST_KILL" =~ ^[0-9]+$ ]] && (( NOW_TS - LAST_KILL < COOLDOWN_SEC )); then
          DO_KILL=0
          echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] SMARTLOOP_WRAPPER skip cooldown_active last_kill_age_sec=$((NOW_TS - LAST_KILL))" >&2
        fi
      fi
      if [[ "$DO_KILL" -eq 1 ]]; then
        if neuropilot_heartbeat_mtime_fresh "$HEARTBEAT_FILE" "$NOW_TS" "$STALE_SEC"; then
          _lw=$(stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
          [[ "$_lw" =~ ^[0-9]+$ ]] || _lw=0
          echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] SMARTLOOP_WRAPPER skip file_activity_detected mtime_age_sec=$((NOW_TS - _lw)) threshold=${STALE_SEC}" >&2
        elif neuropilot_last_progress_ts_fresh "$LAST_PROGRESS_FILE" "$NOW_TS" "$STALE_SEC"; then
          IFS= read -r _lp < "$LAST_PROGRESS_FILE" || _lp=0
          [[ "$_lp" =~ ^[0-9]+$ ]] || _lp=0
          echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] SMARTLOOP_WRAPPER skip progress_ts_fresh file=$LAST_PROGRESS_FILE progress_ts=${_lp} progress_age_sec=$((NOW_TS - _lp)) threshold=${STALE_SEC} $(neuropilot_pipeline_progress_log_suffix "$HEARTBEAT_FILE")" >&2
        elif neuropilot_smart_loop_cpu_active; then
          echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] SMARTLOOP_WRAPPER skip active_process_detected (cpu>0 on run-smart-evolution-loop)" >&2
        else
          echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] SMARTLOOP_WRAPPER stale_heartbeat last_ts=$LAST_TS age_sec=$((NOW_TS - LAST_TS_SEC)) threshold=${STALE_SEC} — attempting recovery" >&2
          terminate_smart_loop_procs
          sleep 5
          neuropilot_remove_smart_loop_lock "$DATA_ROOT" "wrapper_stale_heartbeat_recovery"
          printf '%s\n' "$NOW_TS" > "$COOLDOWN_FILE"
        fi
      fi
    fi
  fi
fi

# If a previous smart-loop was SIGKILL'd, the lock directory can remain and block every relaunch.
# Remove it only when no run-smart-evolution-loop.sh process is running.
if ! pgrep -f "run-smart-evolution-loop\\.sh" >/dev/null 2>&1; then
  neuropilot_remove_smart_loop_lock "$DATA_ROOT" "orphan_no_smartloop_process"
fi

# Load secrets from .env without printing them.
ENV_FILE="${NEUROPILOT_ENV_FILE:-$PROJECT_ROOT/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

exec /usr/bin/env bash "$PROJECT_ROOT/run-smart-evolution-loop.sh"
