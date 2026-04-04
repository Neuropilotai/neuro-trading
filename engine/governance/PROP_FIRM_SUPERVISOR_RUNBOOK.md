# Prop-firm supervisor runbook

## Philosophy

- **`engine/governance/run_loop_auto.sh` is sacred** — canonical operator loop; the supervisor wraps it, never replaces its business logic.
- **Paper / execution / strict mapping / promote guards** stay untouched by supervisor scripts.
- **Supervisor-only artefacts** live under `ops-snapshot/` (`supervisor_status.json`, `watchdog_status.json`, `neuropilot_health.json`, `http_server_status.json`) and `logs/`.

## Architecture

| Layer | Role |
|--------|------|
| Core | `run_loop_auto.sh` → `npm run governance:promoted-paper-7d-loop` |
| Data refresh | `refresh_datasets_auto.sh` (called periodically from loop) |
| Operator paper | `run_promoted_paper_7d_loop.sh` (invoked by npm script above) |
| Export | `exportOpsSnapshot.js` (dashboards / ops JSON) |
| **Supervisor** | watchdog + health monitor + HTTP + launcher + stop + alerts + circuit breaker |

## Scripts

| Script | Purpose |
|--------|---------|
| `watchdog_neuropilot.sh` | Process + heartbeat (`paper_exec_v1_last_run.json` + `governance_dashboard.json`), bounded restarts/hour, lock, circuit-breaker gate |
| `monitor_neuropilot_health.sh` | One-shot health snapshot → `neuropilot_health.{json,md}` + `incident_status.json` |
| `monitorNeuropilotHealthCore.js` | Node helper (read-only aggregation) |
| `send_neuropilot_alert.sh` | Local `logs/alerts_neuropilot.log` + optional Slack/Telegram (no secrets logged); fingerprint rate limit |
| `circuit_breaker_neuropilot.sh` / `circuitBreakerNeuropilotCore.js` | Supervision-only breaker state (`ops-snapshot/circuit_breaker_status.json`) |
| `serve_dashboard_local.sh` | `python3 -m http.server` from **repo root** (URLs include `/ops-snapshot/`) |
| `run_health_monitor_loop.sh` | Interval health + `circuitBreaker … evaluate` + alerts on status / mode transitions |
| `start_neuropilot_canonical.sh` | Starts loop + watchdog + health loop + HTTP; optional live Terminal watch |
| `stop_neuropilot_canonical.sh` | Stops supervisor processes (narrow `pkill` + PID file + port); `supervisor_status` → STOPPED |

## Environment variables

### Launcher defaults (`start_neuropilot_canonical.sh`)

- `NEUROPILOT_DATA_ROOT` (default `/Volumes/TradingDrive/NeuroPilotAI`)
- `NEUROPILOT_WAVE1_SYMBOLS` (default `BTCUSDT,ETHUSDT`)
- `NEUROPILOT_WAVE1_PAPER_SCALE_MODE` (default `1`)
- `NEUROPILOT_WAVE1_FORCE_SIGNALS` (default `1`)
- `NP_HTTP_PORT` (default `8080`)
- `NP_CANONICAL_FORCE_RESTART=1` — start even if PID file suggests stack already up

### Watchdog

- `NP_WATCHDOG_MAX_LOOP_SILENCE_SEC` (default `600`) — `writtenAt` on `paper_exec_v1_last_run.json`
- `NP_WATCHDOG_MAX_DASH_SILENCE_SEC` (default `900`) — `generatedAt` on `ops-snapshot/governance_dashboard.json`
- `NP_WATCHDOG_POLL_SEC` (default `20`)
- `NP_WATCHDOG_RESTART_COOLDOWN_SEC` (default `60`)
- `NP_WATCHDOG_MAX_RESTARTS_PER_HOUR` (default `6`) — excess → escalate + circuit breaker OPEN
- `NP_WATCHDOG_ENABLE_RESTART` (default `1`; set `0` for alert-only)
- `NP_WATCHDOG_IGNORE_CIRCUIT_BREAKER=1` — bypass breaker gate (use sparingly)
- `NP_WATCHDOG_ONE_SHOT=1` — single check cycle

### Health loop

- `NP_HEALTH_MONITOR_INTERVAL_SEC` (default `60`)

### Alerts (optional)

- `NP_SLACK_WEBHOOK_URL` — incoming webhook (value never logged)
- `NP_TELEGRAM_BOT_TOKEN` + `NP_TELEGRAM_CHAT_ID`
- `NP_ALERT_MIN_INTERVAL_SEC` (default `300`) — dedupe per fingerprint in `ops-snapshot/alert_state.json`

### Circuit breaker

- `NP_CIRCUIT_BREAKER_ENABLED` (default `1`; `0` disables transitions)
- `NP_CIRCUIT_BREAKER_OPEN_COOLDOWN_SEC` (default `900`)
- `NP_CIRCUIT_BREAKER_CONSEC_CRITICAL_THRESHOLD` (default `3`)
- `NP_FORCE_CIRCUIT_BREAKER_OPEN=1` — force OPEN (supervision incident)

### Launcher

- `NEUROPILOT_OPEN_LIVE_TERMINAL=0` — skip macOS Terminal watch script

### HTTP

- `NP_HTTP_KILL_EXISTING=1` — free port before bind (in `serve_dashboard_local.sh`)

## Launch

```bash
cd /path/to/neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"
npm run governance:start-canonical
```

Or: `bash engine/governance/start_neuropilot_canonical.sh`

## Stop

```bash
npm run governance:stop-canonical
```

## Monitoring live

- `tail -f logs/run_loop_auto.log`
- `tail -f logs/watchdog_neuropilot.log`
- `tail -f logs/monitor_neuropilot_health.log`
- `cat ops-snapshot/neuropilot_health.md`
- `jq . ops-snapshot/supervisor_status.json`
- `jq . ops-snapshot/incident_status.json`
- `jq . ops-snapshot/circuit_breaker_status.json`
- `npm run governance:circuit-breaker-status`

## Incident checklists

### Loop dead

1. `pgrep -f 'engine/governance/run_loop_auto\\.sh'`
2. `tail -n 80 logs/run_loop_auto.outer.log`
3. `ops-snapshot/watchdog_status.json` — `lastRestartReason`, `action`
4. Manual: `bash engine/governance/run_loop_auto.sh` (foreground for debug)

### Dashboard stale

1. `jq '.generatedAt' ops-snapshot/governance_dashboard.json`
2. Re-run export: `node engine/evolution/scripts/exportOpsSnapshot.js`
3. Check `NP_WATCHDOG_MAX_DASH_SILENCE_SEC`

### Datasets degraded

1. `jq '[.datasets[]|select(.status==\"degraded\")]|length' ops-snapshot/datasets_freshness.json`
2. `bash engine/governance/refresh_datasets_auto.sh` (if installed)

### No append too long

1. `jq '{writtenAt,effectiveAppended,duplicateSkippedPersistent,promotedReplayBypassCount}' "$NEUROPILOT_DATA_ROOT/governance/paper_exec_v1_last_run.json"`
2. `npm run governance:promoted-recent-checkpoint -- --json`

### Broker not connected

1. `jq '{mode,brokerConnected}' ops-snapshot/execution_status.json`
2. Expected in **paper** mode: broker may be disconnected; flag is informational unless you rely on live reconciliation.

### Restarts excessifs / watchdog storm

1. `jq . ops-snapshot/watchdog_status.json` — `restartHistory`, `lastRestartReason`
2. `NP_WATCHDOG_MAX_RESTARTS_PER_HOUR` — lower or fix root cause before raising cap
3. If `circuit_breaker_status.json` → `OPEN`, investigate before `NP_WATCHDOG_IGNORE_CIRCUIT_BREAKER=1`

### Circuit breaker open

1. `jq . ops-snapshot/circuit_breaker_status.json`
2. `npm run governance:circuit-breaker-status`
3. Health monitor keeps running; watchdog restarts are gated until HALF_OPEN/CLOSED per core logic
4. After fix: allow cooldown or clear `NP_FORCE_CIRCUIT_BREAKER_OPEN`; re-evaluate with `node engine/governance/circuitBreakerNeuropilotCore.js evaluate`

## Artefacts & logs (supervisor)

| Path | Purpose |
|------|---------|
| `logs/neuropilot_supervisor_stack.pids` | PIDs from last `start_neuropilot_canonical` |
| `logs/watchdog_neuropilot.log` | Watchdog decisions |
| `logs/monitor_neuropilot_health.log` | Health monitor runs |
| `logs/http_server.out` | Python HTTP stderr/stdout |
| `ops-snapshot/supervisor_status.json` | High-level supervisor state |
| `ops-snapshot/watchdog_status.json` | Last watchdog cycle |
| `ops-snapshot/neuropilot_health.json` | Aggregated health |
| `ops-snapshot/neuropilot_health.md` | Human-readable health |
| `ops-snapshot/incident_status.json` | Incident-oriented slice for commander |
| `ops-snapshot/circuit_breaker_status.json` | Breaker state machine |
| `ops-snapshot/alert_state.json` | Alert dedupe timestamps (fingerprints) |
| `ops-snapshot/http_server_status.json` | HTTP server metadata |
| `logs/alerts_neuropilot.log` | All alert attempts (no secrets) |
| `logs/live_supervisor_watch.sh` | Regenerated live dashboard script (Terminal watch) |

## npm aliases

See `package.json`: `governance:start-canonical`, `governance:stop-canonical`, `governance:watchdog`, `governance:health-monitor`, `governance:serve-dashboard`, `governance:health-loop`, `governance:send-alert`, `governance:circuit-breaker-status`.
