# Live monitor — copy/paste

Set repo and data root:

```bash
cd /path/to/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"
```

## Tail logs

```bash
tail -f logs/run_loop_auto.log
```

```bash
tail -f logs/watchdog_neuropilot.log
```

```bash
tail -f logs/monitor_neuropilot_health.log
```

```bash
tail -f logs/health_monitor_loop.log
```

## jq quick checks

```bash
jq '{writtenAt,effectiveAppended,duplicateSkippedPersistent,promotedReplayBypassCount}' "${NEUROPILOT_DATA_ROOT}/governance/paper_exec_v1_last_run.json"
```

```bash
jq '{generatedAt,promotedUniverseCount,overlapCount}' "${NEUROPILOT_DATA_ROOT}/governance/paper_trades_strict_mapping_report.json"
```

```bash
jq '{supervisorStatus,startedAt,pids,lastHealthCheckAt}' ops-snapshot/supervisor_status.json
```

```bash
jq '{action,loopProcessRunning,lastRunWrittenAtAgeSec,dashboardGeneratedAtAgeSec,lastRestartReason}' ops-snapshot/watchdog_status.json
```

```bash
jq '{overallStatus,operatorLoopStatusLatest,staleFlags,recommendedAction}' ops-snapshot/neuropilot_health.json
```

```bash
jq '{incidentSeverity,incidentMode,circuitBreakerActive,incidentFingerprint,topConcerns}' ops-snapshot/neuropilot_health.json
```

```bash
jq . ops-snapshot/incident_status.json
```

```bash
jq '{state,reason,consecutiveCritical,updatedAt}' ops-snapshot/circuit_breaker_status.json
```

```bash
npm run governance:circuit-breaker-status
```

```bash
grep OPERATOR_LOOP_STATUS logs/run_loop_auto.log | tail -5
```

```bash
bash logs/live_supervisor_watch.sh
```

## Open dashboards (browser)

```bash
open "http://127.0.0.1:8080/ops-snapshot/governance_dashboard.html"
```

```bash
test -f ops-snapshot/owner_ops_dashboard.html && open "http://127.0.0.1:8080/ops-snapshot/owner_ops_dashboard.html"
```

## PIDs

```bash
cat logs/neuropilot_supervisor_stack.pids
```

```bash
pgrep -fl 'engine/governance/run_loop_auto'
```

## Heartbeats (age in minutes, rough)

```bash
node -e "const fs=require('fs'),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));const t=Date.parse(j.writtenAt);console.log('last_run_age_min',((Date.now()-t)/60000).toFixed(2));" "${NEUROPILOT_DATA_ROOT}/governance/paper_exec_v1_last_run.json"
```

## One-shot health / watchdog

```bash
bash engine/governance/monitor_neuropilot_health.sh
```

```bash
NP_WATCHDOG_ONE_SHOT=1 bash engine/governance/watchdog_neuropilot.sh
```

## Relaunch stack

```bash
npm run governance:stop-canonical
NP_CANONICAL_FORCE_RESTART=1 npm run governance:start-canonical
```

## Test alert (hooks optional)

```bash
npm run governance:send-alert -- --severity warn --title "NeuroPilot alert test" --message "desk quant ping" --fingerprint "manual_test_$(date +%s)"
```

## Replay boost policy (desk-quant)

```bash
npm run governance:build-replay-boost-policy
```

```bash
npm run governance:show-replay-boost-top
```

```bash
jq '{generatedAt,policyMode,summary,globalControls}' "${NEUROPILOT_DATA_ROOT}/governance/replay_boost_policy.json"
```

```bash
jq '[.allocations[]|select(.priorityTier=="boosted")]|map(.setupId)' "${NEUROPILOT_DATA_ROOT}/governance/replay_boost_policy.json"
```

```bash
jq '[.allocations[]|select(.priorityTier=="frozen")]|map(.setupId)' "${NEUROPILOT_DATA_ROOT}/governance/replay_boost_policy.json"
```

```bash
jq '{replayBoostPolicyEnabled,replayBoostPolicyMode,replayBoostBoostedSeen,replayBoostBoostedUsed,replayBoostFrozenSkipped,replayBoostReasonHistogram}' "${NEUROPILOT_DATA_ROOT}/governance/paper_exec_v1_last_run.json"
```

```bash
node -e "const fs=require('fs'),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));const t=Date.parse(j.generatedAt);console.log('policy_age_min',((Date.now()-t)/60000).toFixed(2));" "${NEUROPILOT_DATA_ROOT}/governance/replay_boost_policy.json"
```

## Operator checkpoint (JSON)

```bash
npm run governance:promoted-recent-checkpoint -- --json
```
