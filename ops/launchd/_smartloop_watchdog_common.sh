# Shared helpers for run-smartloop.sh and run-smartloop-watchdog.sh (sourced, not executed).
# shellcheck shell=bash

# True (exit 0) if heartbeat file was modified within STALE_SEC of NOW_TS (mtime, macOS: stat -f %m).
# Catches cases where the last line timestamp looks stale but the file is still being written (e.g. parse/tail skew, flush).
neuropilot_heartbeat_mtime_fresh() {
  local hb="${1:?}" now="${2:?}" threshold="${3:?}"
  local m
  m=$(stat -f %m "$hb" 2>/dev/null || echo 0)
  [[ "$m" =~ ^[0-9]+$ ]] || m=0
  [[ "$now" =~ ^[0-9]+$ ]] && [[ "$threshold" =~ ^[0-9]+$ ]] || return 1
  (( now - m < threshold ))
}

# True (exit 0) if loop_logs/last_progress.ts exists and first line is a Unix epoch within STALE_SEC of NOW_TS.
# Written by runFullPipelineExpanded.sh (pipeline_heartbeat_stage) alongside heartbeat.log lines.
neuropilot_last_progress_ts_fresh() {
  local path="${1:?}" now="${2:?}" threshold="${3:?}"
  local line age
  [[ -f "$path" ]] || return 1
  IFS= read -r line < "$path" || return 1
  [[ "$line" =~ ^[0-9]+$ ]] || return 1
  [[ "$now" =~ ^[0-9]+$ ]] && [[ "$threshold" =~ ^[0-9]+$ ]] || return 1
  age=$((now - line))
  (( age < threshold ))
}

# Log suffix: last line in last N lines of heartbeat containing PIPELINE_STAGE= (stage + seq hints for ops).
neuropilot_pipeline_progress_log_suffix() {
  local hb="${1:?}"
  local n="${2:-500}"
  local line st seq
  line=$(tail -n "$n" "$hb" 2>/dev/null | grep 'PIPELINE_STAGE=' | tail -n 1 || true)
  st="n/a"
  seq="n/a"
  if [[ -n "$line" ]]; then
    [[ "$line" =~ PIPELINE_STAGE=([^[:space:]]+) ]] && st="${BASH_REMATCH[1]}"
    [[ "$line" =~ PIPELINE_STAGE_SEQ=([0-9]+) ]] && seq="${BASH_REMATCH[1]}"
  fi
  printf 'pipeline_stage_hint=%s pipeline_stage_seq_hint=%s' "$st" "$seq"
}

# True (exit 0) if any pgrep-matched smart-loop PID reports CPU usage > 0 (float-safe).
neuropilot_smart_loop_cpu_active() {
  local pid line
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    line=$(ps -p "$pid" -o %cpu= 2>/dev/null | tr -d '[:space:]' || true)
    [[ -z "$line" ]] && continue
    awk -v v="$line" 'BEGIN { if (v + 0 > 0) exit 0; exit 1 }' || continue
    return 0
  done < <(pgrep -f "run-smart-evolution-loop\\.sh" 2>/dev/null || true)
  return 1
}

# Log then remove $DATA_ROOT/.smart_loop_lock if present (best-effort).
neuropilot_remove_smart_loop_lock() {
  local dr="${1:?}" reason="${2:?}"
  local ld="$dr/.smart_loop_lock"
  if [[ ! -d "$ld" ]]; then
    return 0
  fi
  mkdir -p "$dr/loop_logs"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] stale_lock_removed ts=$(date -u +%s) reason=${reason} lock=${ld}" >> "$dr/loop_logs/lock_events.log"
  rm -rf "$ld" 2>/dev/null || true
}
