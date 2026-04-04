#!/usr/bin/env bash
set -euo pipefail

# =========================================================
# NeuroPilot Expanded Full Pipeline
# =========================================================
# Flow:
# 1. Run expanded data engine
# 2. For each available dataset CSV under $DATA_ROOT/datasets:
#    - ensure .bin exists
#    - run two-stage discovery
# 3. Run meta pipeline
# 4. Run family expansion engine
# 5. Run strategy evolution
# 5.5 Pattern meta-learning (discovery/pattern_meta_learning.json)
# 6. Run next generation builder (champion → children)
# 7. Reload champions into paper session
# 8. Append evolution_metrics.log + export ops-snapshot/ (local dashboard JSON)
# 8.8 Optional Paper Execution V1 → governance/paper_trades.jsonl (NEUROPILOT_PAPER_EXEC_V1=1)
#
# Watchdog liveness: pipeline_heartbeat_stage writes under $DATA_ROOT/loop_logs/ (same as NEUROPILOT_DATA_ROOT):
#   heartbeat.log (PIPELINE_STAGE= + PIPELINE_STAGE_SEQ=), last_progress.ts (epoch; tmp+mv).
# NOT the repo's ./loop_logs — tail -f "$NEUROPILOT_DATA_ROOT/loop_logs/heartbeat.log". Watchdog: ops/launchd/run-smartloop-watchdog.sh.
#
# Usage:
#   export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
#   ./engine/scripts/runFullPipelineExpanded.sh
# =========================================================

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"
PIPELINE_STARTED_AT_S="$(date +%s)"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "[ERROR] node not found in PATH"
  exit 1
fi

DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/TradingDrive/NeuroPilotAI}"
# Wave1: paper signals, caps, next-gen injection (override anytime)
export NEUROPILOT_WAVE1_SYMBOLS="${NEUROPILOT_WAVE1_SYMBOLS:-BTCUSDT,ETHUSDT,XRPUSDT,ADAUSDT}"
TOP_N="${TOP_N:-30}"
PORTFOLIO_MAX="${PORTFOLIO_MAX:-12}"
MAX_PER_FAMILY="${MAX_PER_FAMILY:-1}"
EXPAND_FAMILIES="${EXPAND_FAMILIES:-1}"
EXPANSION_MAX_FAMILIES="${EXPANSION_MAX_FAMILIES:-12}"
FAMILY_EXPANSION_MODE="${FAMILY_EXPANSION_MODE:-normal}"
FORCE_NEW_FAMILIES="${FORCE_NEW_FAMILIES:-0}"
# Promoted children: require beats_parent on at least N distinct batch files (2 = compromise, 3 = stricter when population grows)
PROMOTED_CHILDREN_MIN_DISTINCT_BATCH_FILES="${PROMOTED_CHILDREN_MIN_DISTINCT_BATCH_FILES:-2}"
LEARNING_MODE_NAME="${NEUROPILOT_LEARNING_MODE:-core_3m}"
export NEUROPILOT_PHASE_TUNER_ENABLED="${NEUROPILOT_PHASE_TUNER_ENABLED:-0}"

if [[ ! -f "$PROJECT_ROOT/config/learning_modes.json" ]]; then
  echo "[ERROR] Missing learning mode config: $PROJECT_ROOT/config/learning_modes.json"
  exit 1
fi

if [[ ! -f "$PROJECT_ROOT/config/market_universe.core.json" ]]; then
  echo "[ERROR] Missing market universe config: $PROJECT_ROOT/config/market_universe.core.json"
  exit 1
fi

MODE_ENV_EXPORTS="$("$NODE_BIN" -e "const fs=require('fs');
const lm=JSON.parse(fs.readFileSync('./config/learning_modes.json','utf8'));
const mu=JSON.parse(fs.readFileSync('./config/market_universe.core.json','utf8'));
const modeName=process.env.LEARNING_MODE_NAME||lm.defaultMode||'core_3m';
const mode=(lm.modes&&lm.modes[modeName])||null;
if(!mode){console.error('[ERROR] Unknown learning mode: '+modeName);process.exit(2);}
const maxMarkets=Math.max(1, Number.isFinite(Number(mode.maxMarkets))?Math.floor(Number(mode.maxMarkets)):2);
const enabled=(Array.isArray(mu.markets)?mu.markets:[]).filter((m)=>m&&m.enabled!==false).slice(0,maxMarkets);
const pairs=[];
const symbols=[];
for(const m of enabled){
  const sym=String(m.symbol||'').toUpperCase();
  if(!sym) continue;
  symbols.push(sym);
  const tfs=Array.isArray(m.timeframes)&&m.timeframes.length?m.timeframes:['5m'];
  for(const tf of tfs){ pairs.push(sym+':'+String(tf).toLowerCase()); }
}
const fam=Array.isArray(mode.allowedFamilies)?mode.allowedFamilies.map((x)=>String(x).trim()).filter(Boolean):[];
const pg=(mode.promotionGuard&&typeof mode.promotionGuard==='object')?mode.promotionGuard:{};
process.stdout.write('RESOLVED_MODE='+modeName+'\\n');
process.stdout.write('RESOLVED_LOOKBACK_DAYS='+(Number(mode.lookbackDays)||90)+'\\n');
process.stdout.write('RESOLVED_PAPER_ONLY='+(mode.paperOnly===true?'1':'0')+'\\n');
process.stdout.write('RESOLVED_LIVE_ENABLED='+(mode.liveTradingEnabled===true?'1':'0')+'\\n');
process.stdout.write('RESOLVED_MAX_MARKETS='+maxMarkets+'\\n');
process.stdout.write('RESOLVED_MAX_FAMILIES='+(Number(mode.maxFamilies)||10)+'\\n');
process.stdout.write('RESOLVED_ALLOWED_SYMBOLS='+symbols.join(',')+'\\n');
process.stdout.write('RESOLVED_ALLOWED_PAIRS='+pairs.join(',')+'\\n');
process.stdout.write('RESOLVED_ALLOWED_FAMILIES='+fam.join(',')+'\\n');
process.stdout.write('RESOLVED_PROMO_MIN_TRADES='+(Number(pg.minTrades)||40)+'\\n');
process.stdout.write('RESOLVED_PROMO_MIN_EXPECTANCY='+(Number(pg.minExpectancy)||0)+'\\n');
process.stdout.write('RESOLVED_PROMO_MAX_DRAWDOWN_PCT='+(Number(pg.maxDrawdownPct)||25)+'\\n');
process.stdout.write('RESOLVED_PROMO_MIN_PROFIT_FACTOR='+(Number(pg.minProfitFactor)||1.05)+'\\n');
process.stdout.write('RESOLVED_PROMO_MAX_TOP_TRADES_SHARE='+(Number(pg.maxTopTradesPnlShare)||0.65)+'\\n');
process.stdout.write('RESOLVED_PROMO_REQUIRE_WALKFORWARD='+(pg.requireWalkForwardPass===false?'0':'1')+'\\n');
")"
while IFS='=' read -r k v; do
  [[ -n "$k" ]] || continue
  case "$k" in
    RESOLVED_MODE) RESOLVED_MODE="$v" ;;
    RESOLVED_LOOKBACK_DAYS) RESOLVED_LOOKBACK_DAYS="$v" ;;
    RESOLVED_PAPER_ONLY) RESOLVED_PAPER_ONLY="$v" ;;
    RESOLVED_LIVE_ENABLED) RESOLVED_LIVE_ENABLED="$v" ;;
    RESOLVED_MAX_MARKETS) RESOLVED_MAX_MARKETS="$v" ;;
    RESOLVED_MAX_FAMILIES) RESOLVED_MAX_FAMILIES="$v" ;;
    RESOLVED_ALLOWED_SYMBOLS) RESOLVED_ALLOWED_SYMBOLS="$v" ;;
    RESOLVED_ALLOWED_PAIRS) RESOLVED_ALLOWED_PAIRS="$v" ;;
    RESOLVED_ALLOWED_FAMILIES) RESOLVED_ALLOWED_FAMILIES="$v" ;;
    RESOLVED_PROMO_MIN_TRADES) RESOLVED_PROMO_MIN_TRADES="$v" ;;
    RESOLVED_PROMO_MIN_EXPECTANCY) RESOLVED_PROMO_MIN_EXPECTANCY="$v" ;;
    RESOLVED_PROMO_MAX_DRAWDOWN_PCT) RESOLVED_PROMO_MAX_DRAWDOWN_PCT="$v" ;;
    RESOLVED_PROMO_MIN_PROFIT_FACTOR) RESOLVED_PROMO_MIN_PROFIT_FACTOR="$v" ;;
    RESOLVED_PROMO_MAX_TOP_TRADES_SHARE) RESOLVED_PROMO_MAX_TOP_TRADES_SHARE="$v" ;;
    RESOLVED_PROMO_REQUIRE_WALKFORWARD) RESOLVED_PROMO_REQUIRE_WALKFORWARD="$v" ;;
  esac
done <<< "$MODE_ENV_EXPORTS"

export NEUROPILOT_LEARNING_MODE="${RESOLVED_MODE:-core_3m}"
export NEUROPILOT_LOOKBACK_DAYS="${RESOLVED_LOOKBACK_DAYS:-90}"
export NEUROPILOT_ALLOWED_FAMILIES="${RESOLVED_ALLOWED_FAMILIES:-}"
export NEUROPILOT_PHASE_A_MAX_FAMILIES="${RESOLVED_MAX_FAMILIES:-10}"
export NEUROPILOT_PHASE_A_ALLOWED_SYMBOLS="${RESOLVED_ALLOWED_SYMBOLS:-}"
export NEUROPILOT_PHASE_A_ALLOWED_PAIRS="${RESOLVED_ALLOWED_PAIRS:-}"
export NEUROPILOT_PROMOTION_GUARD_MIN_TRADES="${RESOLVED_PROMO_MIN_TRADES:-40}"
export NEUROPILOT_PROMOTION_GUARD_MIN_EXPECTANCY="${RESOLVED_PROMO_MIN_EXPECTANCY:-0}"
export NEUROPILOT_PROMOTION_GUARD_MAX_DRAWDOWN_PCT="${RESOLVED_PROMO_MAX_DRAWDOWN_PCT:-25}"
export NEUROPILOT_PROMOTION_GUARD_MIN_PROFIT_FACTOR="${RESOLVED_PROMO_MIN_PROFIT_FACTOR:-1.05}"
export NEUROPILOT_PROMOTION_GUARD_MAX_TOP_TRADES_SHARE="${RESOLVED_PROMO_MAX_TOP_TRADES_SHARE:-0.65}"
export NEUROPILOT_PROMOTION_GUARD_REQUIRE_WALKFORWARD="${RESOLVED_PROMO_REQUIRE_WALKFORWARD:-1}"

if [[ "${RESOLVED_PAPER_ONLY:-0}" == "1" ]]; then
  export NEUROPILOT_EXECUTION_MODE="paper"
  export NEUROPILOT_LIVE_TRADING_ENABLED="0"
fi

if [[ ! -d "$DATA_ROOT" ]]; then
  echo "[ERROR] DATA_ROOT not found: $DATA_ROOT"
  exit 1
fi

# ---------------------------------------------------------
# Reliability guard: if this script is SIGTERM'd mid-run (exit 143),
# write an ops marker with the last known stage + experiment id.
# This does NOT prevent SIGTERM; it makes it traceable/auditable.
# ---------------------------------------------------------
PIPELINE_STAGE="bootstrap"
set_stage() { PIPELINE_STAGE="$1"; }
write_term_marker() {
  local at pid exp out_dir out_file
  at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  pid="$$"
  exp="${EXPERIMENT_ID:-null}"
  out_dir="$DATA_ROOT/loop_logs"
  out_file="$out_dir/pipeline_last_sigterm.json"
  mkdir -p "$out_dir" 2>/dev/null || true
  printf '%s\n' "{\"event\":\"pipeline_sigterm\",\"at\":\"$at\",\"pid\":$pid,\"experimentId\":\"$exp\",\"stage\":\"$PIPELINE_STAGE\"}" > "$out_file" 2>/dev/null || true
  printf '%s\n' "[SIGTERM] pipeline terminating at stage=$PIPELINE_STAGE experimentId=$exp pid=$pid" >&2
}
trap 'write_term_marker; exit 143' TERM

TIMINGS_JSONL="$DATA_ROOT/loop_logs/pipeline_stage_timings.jsonl"
PIPELINE_HEARTBEAT_FILE="$DATA_ROOT/loop_logs/heartbeat.log"
LAST_PROGRESS_FILE="$DATA_ROOT/loop_logs/last_progress.ts"
mkdir -p "$DATA_ROOT/loop_logs" 2>/dev/null || true

PIPELINE_STAGE_SEQ_COUNTER=0

# Progressive liveness for external watchdog: append PIPELINE_STAGE lines + monotonic seq + atomic last_progress.ts.
pipeline_heartbeat_stage() {
  local stage="$1"
  local ts wall tmp
  PIPELINE_STAGE_SEQ_COUNTER=$((PIPELINE_STAGE_SEQ_COUNTER + 1))
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  wall="$(date -u +%s)"
  echo "${ts} PIPELINE_STAGE=${stage} PIPELINE_STAGE_SEQ=${PIPELINE_STAGE_SEQ_COUNTER} pid=$$ experiment=${EXPERIMENT_ID:-}" >> "$PIPELINE_HEARTBEAT_FILE" 2>/dev/null || true
  tmp="${LAST_PROGRESS_FILE}.tmp"
  if printf '%s\n' "$wall" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$LAST_PROGRESS_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
}

now_ms() {
  "$NODE_BIN" -e "process.stdout.write(String(Date.now()))"
}

pipeline_timing() {
  local stage="$1"
  local event="$2"
  local duration="${3:-}"
  local timeout_ms="${4:-}"
  local status="${5:-}"
  STAGE="$stage" EVENT="$event" DURATION="$duration" TIMEOUT_MS="$timeout_ms" STATUS="$status" TIMINGS_FILE="$TIMINGS_JSONL" RUN_ID="${EXPERIMENT_ID:-null}" \
    "$NODE_BIN" -e "const fs=require('fs');
const p=process.env.TIMINGS_FILE;
const obj={ts:new Date().toISOString(),run:process.env.RUN_ID||null,component:'pipeline',stage:process.env.STAGE,event:process.env.EVENT};
if(process.env.DURATION!=='') obj.durationMs=Number(process.env.DURATION);
if(process.env.TIMEOUT_MS!=='') obj.timeoutMs=Number(process.env.TIMEOUT_MS);
if(process.env.STATUS!=='') obj.status=process.env.STATUS;
try{fs.appendFileSync(p, JSON.stringify(obj)+'\n','utf8');}catch(_){}
" >/dev/null 2>&1 || true
}

echo "======================================"
echo "NeuroPilot Expanded Full Pipeline"
echo "PROJECT_ROOT=$PROJECT_ROOT"
echo "DATA_ROOT=$DATA_ROOT"
echo "NODE_BIN=$NODE_BIN"
echo "TOP_N=$TOP_N"
echo "PORTFOLIO_MAX=$PORTFOLIO_MAX"
echo "MAX_PER_FAMILY=$MAX_PER_FAMILY"
echo "EXPAND_FAMILIES=$EXPAND_FAMILIES"
echo "EXPANSION_MAX_FAMILIES=$EXPANSION_MAX_FAMILIES"
echo "FAMILY_EXPANSION_MODE=$FAMILY_EXPANSION_MODE"
echo "FORCE_NEW_FAMILIES=$FORCE_NEW_FAMILIES"
echo "PROMOTED_CHILDREN_MIN_DISTINCT_BATCH_FILES=$PROMOTED_CHILDREN_MIN_DISTINCT_BATCH_FILES"
echo "NEUROPILOT_LEARNING_MODE=${NEUROPILOT_LEARNING_MODE:-core_3m}"
echo "NEUROPILOT_LOOKBACK_DAYS=${NEUROPILOT_LOOKBACK_DAYS:-90}"
echo "NEUROPILOT_EXECUTION_MODE=${NEUROPILOT_EXECUTION_MODE:-paper}"
echo "NEUROPILOT_LIVE_TRADING_ENABLED=${NEUROPILOT_LIVE_TRADING_ENABLED:-0}"
echo "NEUROPILOT_PHASE_A_ALLOWED_SYMBOLS=${NEUROPILOT_PHASE_A_ALLOWED_SYMBOLS:-}"
echo "NEUROPILOT_PHASE_A_ALLOWED_PAIRS=${NEUROPILOT_PHASE_A_ALLOWED_PAIRS:-}"
echo "NEUROPILOT_ALLOWED_FAMILIES=${NEUROPILOT_ALLOWED_FAMILIES:-}"
echo "NEUROPILOT_PROMOTION_GUARD_MIN_TRADES=${NEUROPILOT_PROMOTION_GUARD_MIN_TRADES:-40}"
echo "NEUROPILOT_PROMOTION_GUARD_MIN_EXPECTANCY=${NEUROPILOT_PROMOTION_GUARD_MIN_EXPECTANCY:-0}"
echo "NEUROPILOT_PROMOTION_GUARD_MAX_DRAWDOWN_PCT=${NEUROPILOT_PROMOTION_GUARD_MAX_DRAWDOWN_PCT:-25}"
echo "NEUROPILOT_PROMOTION_GUARD_MIN_PROFIT_FACTOR=${NEUROPILOT_PROMOTION_GUARD_MIN_PROFIT_FACTOR:-1.05}"
echo "NEUROPILOT_PROMOTION_GUARD_MAX_TOP_TRADES_SHARE=${NEUROPILOT_PROMOTION_GUARD_MAX_TOP_TRADES_SHARE:-0.65}"
echo "NEUROPILOT_PROMOTION_GUARD_REQUIRE_WALKFORWARD=${NEUROPILOT_PROMOTION_GUARD_REQUIRE_WALKFORWARD:-1}"
echo "NEUROPILOT_PHASE_TUNER_ENABLED=${NEUROPILOT_PHASE_TUNER_ENABLED:-0}"
echo "======================================"
echo

echo "=== 0/8 Start experiment (governance) ==="
set_stage "0_start_experiment"
EXPERIMENT_ID="$("$NODE_BIN" -e "const g=require('./engine/governance/experimentRegistry'); const id=g.startExperiment({topN:Number(process.env.TOP_N||30),portfolioMax:Number(process.env.PORTFOLIO_MAX||12),expandFamilies:String(process.env.EXPAND_FAMILIES||'1')==='1',mode:process.env.FAMILY_EXPANSION_MODE||'normal'}); console.log(id);")"
export EXPERIMENT_ID
export NEUROPILOT_CYCLE_ID="$EXPERIMENT_ID"
echo "EXPERIMENT_ID=$EXPERIMENT_ID"
echo "NEUROPILOT_CYCLE_ID=$NEUROPILOT_CYCLE_ID"
echo

echo "=== 1/8 Expanded Data Engine ==="
set_stage "1_expanded_data_engine"
pipeline_heartbeat_stage "expanded_data_engine"
t_stage_1="$(now_ms)"
pipeline_timing "1_dataset_refresh" "start"
"$NODE_BIN" engine/data/runExpandedDataEngine.js
pipeline_timing "1_dataset_refresh" "done" "$(( $(now_ms) - t_stage_1 ))"
echo

run_one() {
  local symbol="$1"
  local tf="$2"
  local csv_path="$3"
  local data_group="$4"
  local pair
  local pairs_with_commas
  local this_pair

  pair="$(printf '%s:%s' "$symbol" "$tf" | tr '[:lower:]' '[:upper:]')"
  pairs_with_commas=",$(printf '%s' "${NEUROPILOT_PHASE_A_ALLOWED_PAIRS:-}" | tr '[:lower:]' '[:upper:]'),"
  this_pair=",$pair,"
  if [[ "$pairs_with_commas" != *"$this_pair"* ]]; then
    echo "[SKIP] Mode gate blocked: $symbol/$tf not in allowed pairs (${NEUROPILOT_PHASE_A_ALLOWED_PAIRS:-none})"
    return 0
  fi

  if [[ ! -f "$csv_path" ]]; then
    echo "[SKIP] Missing CSV: $csv_path"
    return 0
  fi

  local line_count
  line_count="$(wc -l < "$csv_path" | tr -d ' ')"

  # Require at least header + 100 bars
  if [[ "$line_count" -lt 101 ]]; then
    echo "[SKIP] Not enough rows in $csv_path (lines=$line_count, need >= 101)"
    return 0
  fi

  echo "--- $symbol $tf ($data_group) ---"
  "$NODE_BIN" engine/scripts/csvToBinary.js "$csv_path" "$symbol" "$tf"
  "$NODE_BIN" engine/discovery/runTwoStageDiscovery.js "$symbol" "$tf" "$data_group"
  echo
}

echo "=== 2/8 Expanded Discovery ==="
set_stage "2_expanded_discovery"
pipeline_heartbeat_stage "expanded_discovery"
t_stage_2="$(now_ms)"
pipeline_timing "2_discovery" "start"

# Equities 5m
run_one SPY    5m "$DATA_ROOT/datasets/spy/spy_5m.csv"       spy_5m
run_one QQQ    5m "$DATA_ROOT/datasets/qqq/qqq_5m.csv"       qqq_5m
run_one IWM    5m "$DATA_ROOT/datasets/iwm/iwm_5m.csv"       iwm_5m
run_one AAPL   5m "$DATA_ROOT/datasets/aapl/aapl_5m.csv"     aapl_5m
run_one NVDA   5m "$DATA_ROOT/datasets/nvda/nvda_5m.csv"     nvda_5m
run_one TSLA   5m "$DATA_ROOT/datasets/tsla/tsla_5m.csv"     tsla_5m

# Crypto 5m / 15m / 1h
run_one BTCUSDT 5m  "$DATA_ROOT/datasets/btcusdt/btcusdt_5m.csv"   btcusdt_5m
run_one BTCUSDT 15m "$DATA_ROOT/datasets/btcusdt/btcusdt_15m.csv"  btcusdt_15m
run_one BTCUSDT 1h  "$DATA_ROOT/datasets/btcusdt/btcusdt_1h.csv"   btcusdt_1h

run_one ETHUSDT 5m  "$DATA_ROOT/datasets/ethusdt/ethusdt_5m.csv"   ethusdt_5m
run_one ETHUSDT 15m "$DATA_ROOT/datasets/ethusdt/ethusdt_15m.csv"  ethusdt_15m
run_one ETHUSDT 1h  "$DATA_ROOT/datasets/ethusdt/ethusdt_1h.csv"   ethusdt_1h

run_one SOLUSDT 5m  "$DATA_ROOT/datasets/solusdt/solusdt_5m.csv"   solusdt_5m
run_one SOLUSDT 15m "$DATA_ROOT/datasets/solusdt/solusdt_15m.csv"  solusdt_15m
run_one SOLUSDT 1h  "$DATA_ROOT/datasets/solusdt/solusdt_1h.csv"   solusdt_1h

run_one BNBUSDT 5m  "$DATA_ROOT/datasets/bnbusdt/bnbusdt_5m.csv"   bnbusdt_5m
run_one BNBUSDT 15m "$DATA_ROOT/datasets/bnbusdt/bnbusdt_15m.csv"  bnbusdt_15m
run_one BNBUSDT 1h  "$DATA_ROOT/datasets/bnbusdt/bnbusdt_1h.csv"   bnbusdt_1h

# Alt crypto
run_one ADAUSDT 5m  "$DATA_ROOT/datasets/adausdt/adausdt_5m.csv"   adausdt_5m
run_one ADAUSDT 15m "$DATA_ROOT/datasets/adausdt/adausdt_15m.csv"  adausdt_15m
run_one ADAUSDT 1h  "$DATA_ROOT/datasets/adausdt/adausdt_1h.csv"   adausdt_1h

run_one XRPUSDT 5m  "$DATA_ROOT/datasets/xrpusdt/xrpusdt_5m.csv"   xrpusdt_5m
run_one XRPUSDT 15m "$DATA_ROOT/datasets/xrpusdt/xrpusdt_15m.csv"  xrpusdt_15m
run_one XRPUSDT 1h  "$DATA_ROOT/datasets/xrpusdt/xrpusdt_1h.csv"   xrpusdt_1h

# Forex
run_one EURUSD 5m  "$DATA_ROOT/datasets/eurusd/eurusd_5m.csv"   eurusd_5m
run_one EURUSD 15m "$DATA_ROOT/datasets/eurusd/eurusd_15m.csv"  eurusd_15m
run_one EURUSD 1h  "$DATA_ROOT/datasets/eurusd/eurusd_1h.csv"   eurusd_1h

run_one GBPUSD 5m  "$DATA_ROOT/datasets/gbpusd/gbpusd_5m.csv"   gbpusd_5m
run_one GBPUSD 15m "$DATA_ROOT/datasets/gbpusd/gbpusd_15m.csv"  gbpusd_15m
run_one GBPUSD 1h  "$DATA_ROOT/datasets/gbpusd/gbpusd_1h.csv"   gbpusd_1h

run_one USDJPY 5m  "$DATA_ROOT/datasets/usdjpy/usdjpy_5m.csv"   usdjpy_5m
run_one USDJPY 15m "$DATA_ROOT/datasets/usdjpy/usdjpy_15m.csv"  usdjpy_15m
run_one USDJPY 1h  "$DATA_ROOT/datasets/usdjpy/usdjpy_1h.csv"   usdjpy_1h

# XAUUSD
run_one XAUUSD 5m "$DATA_ROOT/datasets/xauusd/xauusd_5m.csv" xauusd_5m
run_one XAUUSD 15m "$DATA_ROOT/datasets/xauusd/xauusd_15m.csv" xauusd_15m
run_one XAUUSD 1h "$DATA_ROOT/datasets/xauusd/xauusd_1h.csv" xauusd_1h
"$NODE_BIN" -e "const g=require('./engine/governance/experimentRegistry'); const p=process.env.NEUROPILOT_DATA_ROOT || require('./engine/dataRoot').getDataRoot(); g.appendArtifact(process.env.EXPERIMENT_ID,'discovery', p + '/batch_results');"
pipeline_timing "2_discovery" "done" "$(( $(now_ms) - t_stage_2 ))"

echo "=== 3/8 Meta Pipeline ==="
set_stage "3_meta_pipeline"
pipeline_heartbeat_stage "meta_start"
t_stage_3="$(now_ms)"
pipeline_timing "3_meta_pipeline" "start"
MAX_PER_FAMILY="$MAX_PER_FAMILY" \
"$NODE_BIN" engine/meta/runMetaPipeline.js "$TOP_N" "$PORTFOLIO_MAX"
"$NODE_BIN" -e "const g=require('./engine/governance/experimentRegistry'); const p=process.env.NEUROPILOT_DATA_ROOT || require('./engine/dataRoot').getDataRoot(); g.appendArtifact(process.env.EXPERIMENT_ID,'meta', p + '/discovery/meta_ranking.json'); g.appendArtifact(process.env.EXPERIMENT_ID,'portfolio', p + '/discovery/strategy_portfolio.json');"
pipeline_timing "3_meta_pipeline" "done" "$(( $(now_ms) - t_stage_3 ))"
pipeline_heartbeat_stage "correlation"
echo

echo "=== 3.6/8 Adaptive Mutation Policy (P5) ==="
set_stage "3_6_adapt_mutation_policy_p5"
# P5 temporal contract: runs BEFORE supervisor (3.7) and BEFORE end-of-run mini (8.5).
# governance_mini_report.json on disk here is the *previous* cycle's mini — intentional (see engine/evolution/P5_TEMPORAL_CONTRACT.md).
"$NODE_BIN" engine/evolution/adaptMutationPolicy.js
"$NODE_BIN" -e "const g=require('./engine/governance/experimentRegistry'); const p=process.env.NEUROPILOT_DATA_ROOT || require('./engine/dataRoot').getDataRoot(); g.appendArtifact(process.env.EXPERIMENT_ID,'mutation_policy', p + '/discovery/mutation_policy.json');"
echo

# Snapshot meta_ranking for evolution: nightly history needs performance metrics (expectancy, trades, meta_score).
TS="$(date +%Y%m%d_%H%M%S)"
SNAP_DIR="$DATA_ROOT/brain_snapshots"
mkdir -p "$SNAP_DIR"
if [[ -f "$DATA_ROOT/discovery/meta_ranking.json" ]]; then
  cp "$DATA_ROOT/discovery/meta_ranking.json" "$SNAP_DIR/meta_ranking_${TS}.json" \
    || echo "[WARN] Could not snapshot meta_ranking.json"
fi

echo "=== 4/8 Family Expansion ==="
echo "=== 3.7/8 Research Supervisor ==="
set_stage "3_7_research_supervisor"
t_stage_6="$(now_ms)"
pipeline_timing "6_validation" "start"
"$NODE_BIN" engine/supervisor/researchSupervisor.js
SUPERVISOR_CYCLE_VALID="$("$NODE_BIN" -e "const fs=require('fs'); const p=(process.env.NEUROPILOT_DATA_ROOT||require('./engine/dataRoot').getDataRoot()) + '/discovery/supervisor_config.json'; try { const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log(j && j.cycle_valid===false ? '0':'1'); } catch { console.log('1'); }")"
echo "SUPERVISOR_CYCLE_VALID=$SUPERVISOR_CYCLE_VALID"
echo

echo "=== 3.75/8 Portfolio Governor (P6) ==="
set_stage "3_75_portfolio_governor_p6"
"$NODE_BIN" engine/portfolio/portfolioGovernor.js
"$NODE_BIN" -e "const g=require('./engine/governance/experimentRegistry'); const p=process.env.NEUROPILOT_DATA_ROOT || require('./engine/dataRoot').getDataRoot(); g.appendArtifact(process.env.EXPERIMENT_ID,'portfolio_governor', p + '/discovery/portfolio_governor.json');"
echo

echo "=== 3.5/8 Promote winning children ==="
set_stage "3_5_promote_winning_children"
"$NODE_BIN" engine/evolution/buildPromotedChildren.js
pipeline_timing "6_validation" "done" "$(( $(now_ms) - t_stage_6 ))"
pipeline_heartbeat_stage "validation_promotion_done"
echo

if [[ "$EXPAND_FAMILIES" == "1" && "$SUPERVISOR_CYCLE_VALID" == "1" ]]; then
  set_stage "4_family_expansion"
  FAMILY_ARGS=("$EXPANSION_MAX_FAMILIES" "--mode" "$FAMILY_EXPANSION_MODE")
  if [[ "$FORCE_NEW_FAMILIES" == "1" ]]; then
    FAMILY_ARGS+=("--forceNewFamilies")
  fi
  "$NODE_BIN" engine/evolution/familyExpansionEngine.js "${FAMILY_ARGS[@]}"
else
  echo "[SKIP] Family expansion disabled or cycle degraded (EXPAND_FAMILIES=$EXPAND_FAMILIES, SUPERVISOR_CYCLE_VALID=$SUPERVISOR_CYCLE_VALID)"
fi
echo

pipeline_heartbeat_stage "pre_strategy_evolution"

echo "=== 5/8 Strategy Evolution ==="
set_stage "5_strategy_evolution"
pipeline_heartbeat_stage "evolution"
t_stage_4="$(now_ms)"
pipeline_timing "4_registry" "start"
"$NODE_BIN" engine/evolution/strategyEvolution.js
"$NODE_BIN" -e "const g=require('./engine/governance/experimentRegistry'); const p=process.env.NEUROPILOT_DATA_ROOT || require('./engine/dataRoot').getDataRoot(); g.appendArtifact(process.env.EXPERIMENT_ID,'registry', p + '/champion_setups/champion_registry.json');"
pipeline_timing "4_registry" "done" "$(( $(now_ms) - t_stage_4 ))"
echo

echo "=== 5.5/8 Pattern meta-learning ==="
set_stage "5_5_pattern_meta_learning"
"$NODE_BIN" engine/evolution/buildPatternMetaLearning.js
echo

echo "=== 6/8 Next Generation Builder ==="
set_stage "6_next_generation_builder"
"$NODE_BIN" engine/evolution/buildNextGenerationFromChampions.js
echo

echo "=== 7/8 Paper — reload champions ==="
set_stage "7_paper_reload_champions"
"$NODE_BIN" engine/paper/runPaperSession.js --reload-champions
echo

echo "=== 8/8 Ops metrics + interim dashboard snapshot (repo ops-snapshot/) ==="
set_stage "8_ops_snapshot_interim"
# Interim: evolution metrics + P8.1 from state *before* final mini report + P7 (see 8.7 for final alignment).
# Keeps local ops-dashboard in sync with smart loop / full pipeline (not only runEvolutionBaseline.sh).
"$NODE_BIN" engine/evolution/scripts/appendEvolutionMetricsLog.js
"$NODE_BIN" engine/evolution/scripts/exportOpsSnapshot.js
"$NODE_BIN" -e "const g=require('./engine/governance/experimentRegistry'); const p=process.env.NEUROPILOT_DATA_ROOT || require('./engine/dataRoot').getDataRoot(); g.appendArtifact(process.env.EXPERIMENT_ID,'ops_snapshot', p + '/discovery/supervisor_config.json');"
echo

echo "=== 8.5/8 Governance mini report ==="
set_stage "8_5_governance_mini_report"
t_stage_7="$(now_ms)"
pipeline_timing "7_governance_mini" "start"
PIPELINE_ENDED_AT_S="$(date +%s)"
PIPELINE_DURATION_MS="$(( (PIPELINE_ENDED_AT_S - PIPELINE_STARTED_AT_S) * 1000 ))"
PIPELINE_EXIT_CODE=0 \
PIPELINE_DURATION_MS="$PIPELINE_DURATION_MS" \
"$NODE_BIN" engine/scripts/generateGovernanceMiniReport.js
pipeline_timing "7_governance_mini" "done" "$(( $(now_ms) - t_stage_7 ))"
echo

echo "=== 8.6/8 Run trend memory (P7) ==="
set_stage "8_6_run_trend_memory_p7"
t_stage_5="$(now_ms)"
pipeline_timing "5_run_trend_memory" "start"
"$NODE_BIN" engine/governance/runTrendMemory.js
"$NODE_BIN" -e "const g=require('./engine/governance/experimentRegistry'); const p=process.env.NEUROPILOT_DATA_ROOT || require('./engine/dataRoot').getDataRoot(); g.appendArtifact(process.env.EXPERIMENT_ID,'run_trend_memory', p + '/discovery/run_trend_memory.json');"
pipeline_timing "5_run_trend_memory" "done" "$(( $(now_ms) - t_stage_5 ))"
echo

echo "=== 8.7/8 Final ops export (P8.1 after mini + P7) ==="
set_stage "8_7_ops_snapshot_final"
t_stage_8="$(now_ms)"
pipeline_timing "8_final_ops_export" "start"
# Refreshes governance_dashboard.json/html + ops JSON so they reflect final governance_mini_report.json and run_trend_memory.json.
"$NODE_BIN" engine/evolution/scripts/exportOpsSnapshot.js
pipeline_timing "8_final_ops_export" "done" "$(( $(now_ms) - t_stage_8 ))"
echo

echo "=== 8.75/8 Wave1 → paper_execution_v1_signals.json (optional) ==="
set_stage "8_75_wave1_paper_signals"
# meta_ranking path: NEUROPILOT_WAVE1_FORCE_SIGNALS=1 — or evolution setups: NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED=1
W1SIG_LC="$(printf '%s' "${NEUROPILOT_WAVE1_FORCE_SIGNALS:-}" | tr '[:upper:]' '[:lower:]')"
W1GEN_LC="$(printf '%s' "${NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED:-}" | tr '[:upper:]' '[:lower:]')"
if [[ "$W1SIG_LC" == "1" || "$W1SIG_LC" == "true" || "$W1SIG_LC" == "yes" || "$W1SIG_LC" == "on" ]] || \
   [[ "$W1GEN_LC" == "1" || "$W1GEN_LC" == "true" || "$W1GEN_LC" == "yes" || "$W1GEN_LC" == "on" ]]; then
  "$NODE_BIN" engine/governance/buildPaperExecutionV1SignalsWave1.js
else
  echo "[SKIP] Wave1 paper signals (NEUROPILOT_WAVE1_FORCE_SIGNALS=1 and/or NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED=1 + NEUROPILOT_WAVE1_SYMBOLS)"
fi
echo

echo "=== 8.8/8 Paper Execution V1 (optional, OFF by default) ==="
set_stage "8_8_paper_execution_v1"
# Append-only governance/paper_trades.jsonl when NEUROPILOT_PAPER_EXEC_V1=1 OR NEUROPILOT_WAVE1_PAPER_SCALE_MODE=1 (same opt-in as runPaperExecutionV1.js).
PEV1_LC="$(printf '%s' "${NEUROPILOT_PAPER_EXEC_V1:-}" | tr '[:upper:]' '[:lower:]')"
W1SCALE_LC="$(printf '%s' "${NEUROPILOT_WAVE1_PAPER_SCALE_MODE:-}" | tr '[:upper:]' '[:lower:]')"
if [[ "$PEV1_LC" == "1" || "$PEV1_LC" == "true" || "$PEV1_LC" == "yes" || "$PEV1_LC" == "on" ]] || \
   [[ "$W1SCALE_LC" == "1" || "$W1SCALE_LC" == "true" || "$W1SCALE_LC" == "yes" || "$W1SCALE_LC" == "on" ]]; then
  "$NODE_BIN" engine/governance/runPaperExecutionV1.js
else
  echo "[SKIP] Paper Execution V1 (set NEUROPILOT_PAPER_EXEC_V1=1 or NEUROPILOT_WAVE1_PAPER_SCALE_MODE=1; add governance/paper_execution_v1_signals.json)"
fi
echo

echo "Done. Expanded pipeline complete."
echo "Meta ranking:           $DATA_ROOT/discovery/meta_ranking.json"
echo "Strategy families:      $DATA_ROOT/discovery/strategy_families.json"
echo "Family expansion report:$DATA_ROOT/discovery/family_expansion_report.json"
echo "Portfolio:              $DATA_ROOT/discovery/strategy_portfolio.json"
echo "Registry:               $DATA_ROOT/champion_setups/champion_registry.json"
echo "Next gen report:        $DATA_ROOT/discovery/next_generation_report.json"
echo "Pattern meta-learning:  $DATA_ROOT/discovery/pattern_meta_learning.json"
echo "Governance mini report: $DATA_ROOT/discovery/governance_mini_report.json"
echo "Trend memory:           $DATA_ROOT/discovery/run_trend_memory.json"
echo "Portfolio governor:     $DATA_ROOT/discovery/portfolio_governor.json"
echo "Ops snapshot (local):   $PROJECT_ROOT/ops-snapshot/  (final P8.1 after step 8.7)"
echo "Paper trades (V1 opt):  $DATA_ROOT/governance/paper_trades.jsonl  (NEUROPILOT_PAPER_EXEC_V1=1)"
