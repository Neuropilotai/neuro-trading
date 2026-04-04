#!/usr/bin/env bash
set -u

# NeuroPilot Smart Evolution Loop
# - NEUROPILOT_SMART_LOOP_SCALE_MODE=1 → default SLEEP_SECONDS=120 (else 300) unless SLEEP_SECONDS is set
# - Pair with NEUROPILOT_WAVE1_PAPER_SCALE_MODE=1 for denser Wave1 paper signals (6/symbol, 30 total) in builder
# - Runs full pipeline repeatedly
# - Prevents overlapping runs
# - Detects progress using registry + next-gen metrics
# - Stops after N idle cycles
# - Keeps detailed logs and state snapshots

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

export NEUROPILOT_DATA_ROOT="${NEUROPILOT_DATA_ROOT:-$SCRIPT_DIR/data_workspace}"

DATA_ROOT="$NEUROPILOT_DATA_ROOT"
DISCOVERY_DIR="$DATA_ROOT/discovery"
CHAMPION_DIR="$DATA_ROOT/champion_setups"
# Ops: logs live on the data root (e.g. /Volumes/.../NeuroPilotAI/loop_logs), not neuropilot_trading_v2/loop_logs.
LOG_DIR="$DATA_ROOT/loop_logs"
STATE_FILE="$LOG_DIR/smart_loop_state.json"
LOCK_DIR="$DATA_ROOT/.smart_loop_lock"
PIPELINE_SCRIPT="$SCRIPT_DIR/engine/scripts/runFullPipelineExpanded.sh"

# Default 300s; set NEUROPILOT_SMART_LOOP_SCALE_MODE=1 for 120s unless SLEEP_SECONDS already exported.
if [ "${NEUROPILOT_SMART_LOOP_SCALE_MODE:-}" = "1" ]; then
  SLEEP_SECONDS="${SLEEP_SECONDS:-120}"
else
  SLEEP_SECONDS="${SLEEP_SECONDS:-300}"
fi
MAX_IDLE_CYCLES="${MAX_IDLE_CYCLES:-8}"               # stop after 8 no-progress cycles
MAX_TOTAL_CYCLES="${MAX_TOTAL_CYCLES:-0}"             # 0 = unlimited until idle stop
MIN_CHILDREN_PROGRESS="${MIN_CHILDREN_PROGRESS:-1}"   # threshold for next-gen children progress
REQUIRE_REGISTRY_CHANGE="${REQUIRE_REGISTRY_CHANGE:-1}" # 1=yes, 0=no

mkdir -p "$LOG_DIR" "$DISCOVERY_DIR" "$CHAMPION_DIR"

timestamp() {
  date +"%Y-%m-%d %H:%M:%S"
}

log() {
  local msg="$1"
  echo "[$(timestamp)] $msg" | tee -a "$CURRENT_LOG"
}

any_pipeline_component_running() {
  # Prevent overlap across full pipeline AND orphaned sub-stages (e.g. meta) if a previous run was SIGTERM'd.
  # pgrep patterns are conservative and anchored to script paths used in this repo.
  local running=0
  local hits=()

  if pgrep -f "bash .*engine/scripts/runFullPipelineExpanded\\.sh" >/dev/null 2>&1; then
    hits+=("runFullPipelineExpanded.sh")
    running=1
  fi

  if pgrep -f "node .*engine/meta/runMetaPipeline\\.js" >/dev/null 2>&1; then
    hits+=("runMetaPipeline.js")
    running=1
  fi

  if [[ "$running" -eq 1 ]]; then
    printf '%s' "$(IFS=','; echo "${hits[*]}")"
    return 0
  fi
  return 1
}

cleanup() {
  rm -rf "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(timestamp)] Another smart loop appears to be running. Lock: $LOCK_DIR"
  exit 1
fi

CURRENT_LOG="$LOG_DIR/smart_loop_$(date +%Y%m%d_%H%M%S).log"

if [[ ! -f "$PIPELINE_SCRIPT" ]]; then
  log "ERROR: Pipeline script not found: $PIPELINE_SCRIPT"
  exit 1
fi

snapshot_metrics() {
  node <<'NODE'
const fs = require('fs');
const path = require('path');

const dataRoot = process.env.NEUROPILOT_DATA_ROOT;
const registryPath = path.join(dataRoot, 'champion_setups', 'champion_registry.json');
const nextGenPath = path.join(dataRoot, 'discovery', 'next_generation_report.json');
const metaPath = path.join(dataRoot, 'discovery', 'meta_ranking.json');

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function safeHash(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return '';
  }
}

const reg = safeReadJson(registryPath) || {};
const nextGen = safeReadJson(nextGenPath) || {};
const meta = safeReadJson(metaPath) || {};

const setups = Array.isArray(reg.setups) ? reg.setups : [];
const champions = Array.isArray(reg.champions) ? reg.champions : [];
const validated = Array.isArray(reg.validated) ? reg.validated : [];

const mutChampions = champions.filter(r => r && (r.parentSetupId || r.mutationType)).length;
const mutValidated = validated.filter(r => r && (r.parentSetupId || r.mutationType)).length;
const promotedOverParent = setups.filter(r => r && r.statusReason === 'promoted_over_parent').length;
const extinctionCount = setups.filter(r => r && r.liveStatus === 'extinct').length;

const championMomentum = champions
  .map(r => Number(r?.momentumMetaScore))
  .filter(Number.isFinite);

const avgChampionMomentum = championMomentum.length
  ? championMomentum.reduce((a,b)=>a+b,0) / championMomentum.length
  : null;

const metaStrategies = Array.isArray(meta.strategies) ? meta.strategies : [];
const metaTop10 = metaStrategies.slice(0, 10).map(r => String(r.setupId || ''));

const out = {
  registryExists: fs.existsSync(registryPath),
  nextGenExists: fs.existsSync(nextGenPath),
  metaExists: fs.existsSync(metaPath),

  setupsCount: setups.length,
  championsCount: champions.length,
  validatedCount: validated.length,

  mutChampion: mutChampions,
  mutValidated: mutValidated,
  promotedOverParent,
  extinctionCount,
  avgChampionMomentum,

  childrenGenerated: Number(nextGen.childrenGenerated || 0),
  skipNoRules: Number(nextGen.skipReasons?.noRules || 0),

  registryFingerprint: safeHash({
    champions: champions.map(r => ({
      setupId: r.setupId,
      status: r.status,
      statusReason: r.statusReason || null,
      avgMetaScore: r.avgMetaScore ?? null,
      momentumMetaScore: r.momentumMetaScore ?? null
    })),
    validatedTop: validated.slice(0, 20).map(r => ({
      setupId: r.setupId,
      avgMetaScore: r.avgMetaScore ?? null,
      momentumMetaScore: r.momentumMetaScore ?? null
    }))
  }),

  metaTop10Fingerprint: safeHash(metaTop10),
  topChampionIds: champions.slice(0, 15).map(r => String(r.setupId || '')),
  topMetaIds: metaTop10
};

process.stdout.write(JSON.stringify(out));
NODE
}

write_state() {
  local cycle="$1"
  local idle="$2"
  local progress="$3"
  local reason="$4"
  local before_json="$5"
  local after_json="$6"
  printf '%s' "$before_json" > "$LOG_DIR/.smart_loop_before.json"
  printf '%s' "$after_json" > "$LOG_DIR/.smart_loop_after.json"
  export SMART_CYCLE="$cycle"
  export SMART_IDLE="$idle"
  export SMART_PROG="$progress"
  export SMART_REASON="$reason"
  export STATE_FILE_OUT="$STATE_FILE"
  export LOG_DIR_OUT="$LOG_DIR"
  node <<'NODE'
const fs = require('fs');
const path = require('path');
const logDir = process.env.LOG_DIR_OUT;
const before = JSON.parse(fs.readFileSync(path.join(logDir, '.smart_loop_before.json'), 'utf8'));
const after = JSON.parse(fs.readFileSync(path.join(logDir, '.smart_loop_after.json'), 'utf8'));
const state = {
  updatedAt: new Date().toISOString(),
  cycle: Number(process.env.SMART_CYCLE),
  idleCycles: Number(process.env.SMART_IDLE),
  progressDetected: process.env.SMART_PROG === '1',
  reason: process.env.SMART_REASON || '',
  dataRoot: process.env.NEUROPILOT_DATA_ROOT,
  before,
  after
};
fs.writeFileSync(process.env.STATE_FILE_OUT, JSON.stringify(state, null, 2));
NODE
}

detect_progress() {
  local before_json="$1"
  local after_json="$2"

  BEFORE_JSON="$before_json" AFTER_JSON="$after_json" REQUIRE_REGISTRY_CHANGE="$REQUIRE_REGISTRY_CHANGE" MIN_CHILDREN_PROGRESS="$MIN_CHILDREN_PROGRESS" node <<'NODE'
const before = JSON.parse(process.env.BEFORE_JSON);
const after = JSON.parse(process.env.AFTER_JSON);

const requireRegistryChange = Number(process.env.REQUIRE_REGISTRY_CHANGE || 1) === 1;
const minChildrenProgress = Number(process.env.MIN_CHILDREN_PROGRESS || 1);

let reasons = [];

if ((after.childrenGenerated || 0) >= minChildrenProgress && (after.childrenGenerated || 0) !== (before.childrenGenerated || 0)) {
  reasons.push('children_generated_changed');
}

if ((after.championsCount || 0) !== (before.championsCount || 0)) {
  reasons.push('champions_count_changed');
}

if ((after.mutChampion || 0) !== (before.mutChampion || 0)) {
  reasons.push('mut_champion_changed');
}

if ((after.promotedOverParent || 0) !== (before.promotedOverParent || 0)) {
  reasons.push('promoted_over_parent_changed');
}

if ((after.extinctionCount || 0) !== (before.extinctionCount || 0)) {
  reasons.push('extinction_changed');
}

if ((after.avgChampionMomentum ?? null) !== (before.avgChampionMomentum ?? null)) {
  reasons.push('avg_champion_momentum_changed');
}

if ((after.registryFingerprint || '') !== (before.registryFingerprint || '')) {
  reasons.push('registry_fingerprint_changed');
}

if ((after.metaTop10Fingerprint || '') !== (before.metaTop10Fingerprint || '')) {
  reasons.push('meta_top10_changed');
}

const registryChanged = reasons.includes('registry_fingerprint_changed');
const structuralChange = reasons.some(r => r !== 'registry_fingerprint_changed');

const progress =
  structuralChange ||
  (!requireRegistryChange ? registryChanged : false);

process.stdout.write(JSON.stringify({
  progress,
  reasons
}));
NODE
}

cycle=0
idle_cycles=0

log "Smart evolution loop started."
log "DATA_ROOT=$DATA_ROOT"
log "SLEEP_SECONDS=$SLEEP_SECONDS | MAX_IDLE_CYCLES=$MAX_IDLE_CYCLES | MAX_TOTAL_CYCLES=$MAX_TOTAL_CYCLES | SMART_LOOP_SCALE_MODE=${NEUROPILOT_SMART_LOOP_SCALE_MODE:-}"

while true; do
  cycle=$((cycle + 1))
  # Append-only heartbeat for ops / external watchdogs (launchd does not restart on freeze).
  {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) LOOP_HEARTBEAT cycle=$cycle pid=$$"
  } >> "$LOG_DIR/heartbeat.log" 2>/dev/null || true

  log "===== CYCLE $cycle START ====="

  before_metrics="$(snapshot_metrics)"
  log "Before metrics: $before_metrics"

  running_components="$(any_pipeline_component_running || true)"
  if [[ -n "$running_components" ]]; then
    log "SKIP: previous pipeline component still running ($running_components). No overlap."
    after_metrics="$(snapshot_metrics)"
    result='{"progress":false,"reasons":["pipeline_already_running_or_orphaned_stage"]}'
  else
    bash "$PIPELINE_SCRIPT" >> "$CURRENT_LOG" 2>&1
    exit_code=$?
    if [[ $exit_code -ne 0 ]]; then
      log "Pipeline exited with code $exit_code"
    else
      log "Pipeline completed successfully"
    fi

    after_metrics="$(snapshot_metrics)"
    log "After metrics: $after_metrics"

    result="$(detect_progress "$before_metrics" "$after_metrics")"
  fi

  progress="$(echo "$result" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).progress ? 1 : 0")"
  reasons="$(echo "$result" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).reasons.join(',')")"

  if [[ "$progress" -eq 1 ]]; then
    idle_cycles=0
    log "PROGRESS detected: $reasons"
  else
    idle_cycles=$((idle_cycles + 1))
    log "NO PROGRESS: $reasons | idle_cycles=$idle_cycles/$MAX_IDLE_CYCLES"
  fi

  write_state "$cycle" "$idle_cycles" "$progress" "$reasons" "$before_metrics" "$after_metrics"

  if [[ "$MAX_TOTAL_CYCLES" -gt 0 && "$cycle" -ge "$MAX_TOTAL_CYCLES" ]]; then
    log "Stopping: reached MAX_TOTAL_CYCLES=$MAX_TOTAL_CYCLES"
    break
  fi

  if [[ "$idle_cycles" -ge "$MAX_IDLE_CYCLES" ]]; then
    log "Stopping: reached MAX_IDLE_CYCLES=$MAX_IDLE_CYCLES without progress"
    break
  fi

  log "Sleeping $SLEEP_SECONDS seconds..."
  sleep "$SLEEP_SECONDS"
done

log "Smart evolution loop finished."
