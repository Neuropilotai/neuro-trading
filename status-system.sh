#!/usr/bin/env bash
# NeuroPilot — one-glance status: PIDs, running processes, last dashboard snapshot fields.
# Usage: ./status-system.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
DASHBOARD_PORT="${DASHBOARD_PORT:-8080}"
DASH_JSON="$SCRIPT_DIR/ops-snapshot/governance_dashboard.json"

alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pidfile() {
  local f="$1"
  if [[ -f "$f" ]]; then
    cat "$f" 2>/dev/null | tr -d '[:space:]'
  else
    echo ""
  fi
}

LOOP_PID="$(read_pidfile "$LOG_DIR/neuropilot-loop.pid")"
DASH_PID="$(read_pidfile "$LOG_DIR/neuropilot-dashboard.pid")"

LOOP_RUN=false
alive "$LOOP_PID" && LOOP_RUN=true

DASH_RUN=false
alive "$DASH_PID" && DASH_RUN=true
# Fallback: any http.server on our port (may differ from saved PID after restart)
if ! $DASH_RUN && pgrep -fl "python3 -m http\.server ${DASHBOARD_PORT}" >/dev/null 2>&1; then
  DASH_RUN=true
fi

PIPELINE_RUN=false
pgrep -f "runFullPipelineExpanded\.sh" >/dev/null 2>&1 && PIPELINE_RUN=true

META_RUN=false
pgrep -f "runMetaPipeline\.js" >/dev/null 2>&1 && META_RUN=true

SMART_LOOP_RUN=false
pgrep -f "run-smart-evolution-loop\.sh" >/dev/null 2>&1 && SMART_LOOP_RUN=true

# SYSTEM: RUNNING if evolution loop script or child pipeline/meta is active
SYSTEM_STATE="IDLE"
if $SMART_LOOP_RUN || $PIPELINE_RUN || $META_RUN || $LOOP_RUN; then
  SYSTEM_STATE="RUNNING"
fi

# Dashboard line: server up = "running", else "stopped"
DASH_LINE="stopped"
if $DASH_RUN; then
  DASH_LINE="running (port ${DASHBOARD_PORT})"
fi

GENERATED_AT="n/a"
GH_STATUS="n/a"
TOP_ALERT="n/a"
P7_GUARD="n/a"
POLICY_INTERP_LINE="n/a"
PAPER_TRADES_LINE="n/a"
LEARNING_LINE="n/a"

extract_dashboard_fields() {
  [[ -f "$DASH_JSON" ]] || return 1
  if command -v jq >/dev/null 2>&1; then
    GENERATED_AT="$(jq -r '.generatedAt // "n/a"' "$DASH_JSON")"
    GH_STATUS="$(jq -r '.governanceHealth.status // "n/a"' "$DASH_JSON")"
    TOP_ALERT="$(jq -r '(.governanceAlertDigest // {}).topAlert | if . == null then "none" else tostring end' "$DASH_JSON")"
    P7_GUARD="$(jq -r '(.p7GuardMetrics // {}).lastAction | if . == null then "none" else tostring end' "$DASH_JSON")"
    POLICY_INTERP_LINE="$(jq -r '
      .policyInterpretation as $p |
      if $p == null then "POLICY: n/a (rebuild dashboard)"
      elif ($p.status // "") == "expected_by_config" then "POLICY: fallback expected (trend apply disabled)"
      elif ($p.status // "") == "investigate" then "POLICY: fallback investigate"
      elif ($p.status // "") == "unknown" then "POLICY: fallback unknown (check mini report)"
      elif ($p.status // "") == "normal" then "POLICY: normal"
      else "POLICY: " + (($p.status // "n/a") | tostring)
      end
    ' "$DASH_JSON")"
    PAPER_TRADES_LINE="$(jq -r '
      (.paperTradesMetrics // null) as $m |
      (.paperTradesMetricsV2 // null) as $v |
      if $m == null then "PAPER: n/a (rebuild dashboard)"
      else
        (if ($v != null) and ($v.bestStrategy != null) and ($v.bestStrategy.strategyId != null)
          then " bestStrategy=" + ($v.bestStrategy.strategyId | tostring) else " bestStrategy=n/a" end) as $bs |
        (if ($v != null) and ($v.worstStrategy != null) and ($v.worstStrategy.strategyId != null)
          then " worstStrategy=" + ($v.worstStrategy.strategyId | tostring) else " worstStrategy=n/a" end) as $ws |
        "PAPER: trades=" + (($m.validTradeCount // 0) | tostring) +
        " winRate=" + (if $m.winRate == null then "n/a" else (($m.winRate | tostring) + "%") end) +
        " totalPnl=" + (if $m.totalPnl == null then "n/a" else ($m.totalPnl | tostring) end) +
        " parseErrors=" + (($m.parseErrors // 0) | tostring) + $bs + $ws
      end
    ' "$DASH_JSON")"
    LEARNING_LINE="$(jq -r '
      .paperLearningInsights as $x |
      if $x == null then "LEARNING: n/a (rebuild dashboard)"
      else
        "LEARNING: suggestive (confidence=" + ($x.confidence // "low") + ", best=" +
        (($x.summaryBestStrategyId // "n/a") | tostring) + ", worst=" +
        (($x.summaryWorstStrategyId // "n/a") | tostring) + ")"
      end
    ' "$DASH_JSON")"
    return 0
  fi
  local py_out
  py_out="$(python3 - "$DASH_JSON" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    d = json.load(f)
print(d.get("generatedAt") or "n/a")
print((d.get("governanceHealth") or {}).get("status") or "n/a")
ta = (d.get("governanceAlertDigest") or {}).get("topAlert")
print("none" if ta is None else str(ta))
pg = d.get("p7GuardMetrics")
la = None if not isinstance(pg, dict) else pg.get("lastAction")
print("none" if la is None else str(la))
pi = d.get("policyInterpretation")
if not isinstance(pi, dict):
    print("POLICY: n/a (rebuild dashboard)")
else:
    st = pi.get("status") or "normal"
    if st == "expected_by_config":
        print("POLICY: fallback expected (trend apply disabled)")
    elif st == "investigate":
        print("POLICY: fallback investigate")
    elif st == "unknown":
        print("POLICY: fallback unknown (check mini report)")
    elif st == "normal":
        print("POLICY: normal")
    else:
        print("POLICY: " + str(st))
pm = d.get("paperTradesMetrics")
v2 = d.get("paperTradesMetricsV2")
if not isinstance(pm, dict):
    print("PAPER: n/a (rebuild dashboard)")
else:
    vc = pm.get("validTradeCount")
    wr = pm.get("winRate")
    tp = pm.get("totalPnl")
    pe = pm.get("parseErrors") or 0
    wrs = "n/a" if wr is None else str(wr) + "%"
    tps = "n/a" if tp is None else str(tp)
    bs = "n/a"
    ws = "n/a"
    if isinstance(v2, dict):
        b = v2.get("bestStrategy")
        w = v2.get("worstStrategy")
        if isinstance(b, dict) and b.get("strategyId") is not None:
            bs = str(b.get("strategyId"))
        if isinstance(w, dict) and w.get("strategyId") is not None:
            ws = str(w.get("strategyId"))
    print(
        "PAPER: trades="
        + str(vc if vc is not None else 0)
        + " winRate="
        + wrs
        + " totalPnl="
        + tps
        + " parseErrors="
        + str(pe)
        + " bestStrategy="
        + bs
        + " worstStrategy="
        + ws
    )
pli = d.get("paperLearningInsights")
if not isinstance(pli, dict):
    print("LEARNING: n/a (rebuild dashboard)")
else:
    cf = pli.get("confidence") or "low"
    b = pli.get("summaryBestStrategyId")
    w = pli.get("summaryWorstStrategyId")
    print(
        "LEARNING: suggestive (confidence="
        + str(cf)
        + ", best="
        + ("n/a" if b is None else str(b))
        + ", worst="
        + ("n/a" if w is None else str(w))
        + ")"
    )
PY
)"
  GENERATED_AT="$(echo "$py_out" | sed -n '1p')"
  GH_STATUS="$(echo "$py_out" | sed -n '2p')"
  TOP_ALERT="$(echo "$py_out" | sed -n '3p')"
  P7_GUARD="$(echo "$py_out" | sed -n '4p')"
  POLICY_INTERP_LINE="$(echo "$py_out" | sed -n '5p')"
  PAPER_TRADES_LINE="$(echo "$py_out" | sed -n '6p')"
  LEARNING_LINE="$(echo "$py_out" | sed -n '7p')"
  [[ -z "$PAPER_TRADES_LINE" ]] && PAPER_TRADES_LINE="PAPER: n/a (rebuild dashboard)"
  [[ -z "$LEARNING_LINE" ]] && LEARNING_LINE="LEARNING: n/a (rebuild dashboard)"
  return 0
}

if [[ -f "$DASH_JSON" ]]; then
  set +e
  extract_dashboard_fields
  _ex=$?
  set -e
  if [[ $_ex -ne 0 ]]; then
    GENERATED_AT="(could not read governance_dashboard.json)"
  fi
else
  GENERATED_AT="(no governance_dashboard.json — run buildGovernanceDashboard)"
fi

DASH_HEALTH="stopped"
if $DASH_RUN; then
  DASH_HEALTH="healthy"
fi

LOOP_STATE="inactive"
if $SMART_LOOP_RUN || $LOOP_RUN; then
  LOOP_STATE="active"
fi

echo "SYSTEM: $SYSTEM_STATE"
echo "LOOP: $LOOP_STATE (pidfile ${LOOP_PID:-none}, smart_loop_script=$SMART_LOOP_RUN)"
echo "PIPELINE: $($PIPELINE_RUN && echo active || echo inactive)"
echo "META: $($META_RUN && echo active || echo inactive)"
echo "DASHBOARD: $DASH_HEALTH (pidfile ${DASH_PID:-none}, port ${DASHBOARD_PORT})"
echo "GOVERNANCE_HEALTH: $GH_STATUS"
echo "TOP ALERT: $TOP_ALERT"
echo "$POLICY_INTERP_LINE"
echo "$PAPER_TRADES_LINE"
echo "$LEARNING_LINE"
echo "P7 GUARD: $P7_GUARD"
echo "GENERATED AT: $GENERATED_AT"
