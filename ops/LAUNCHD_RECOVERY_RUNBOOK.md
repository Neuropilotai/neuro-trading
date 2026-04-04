# NeuroPilot Launchd Recovery Runbook

## Scope

This runbook operates the system in 4 layers:

- Persistent service `near-live` (launchd)
- Persistent service `smart-loop` (launchd)
- Persistent service `watchdog` (launchd)
- Health check gate (`engine/scripts/checkSystemHealth.js`)

Both services use:

- Working directory: `/Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2`
- Data root: `/Volumes/TradingDrive/NeuroPilotAI`
- Dedicated logs under `logs/`

## Service Files

- `ops/launchd/com.neuropilot.nearlive.plist`
- `ops/launchd/com.neuropilot.smartloop.plist`
- `ops/launchd/com.neuropilot.watchdog.plist`
- `ops/launchd/com.neuropilot.watchdog.smoketest.plist`
- `ops/launchd/run-nearlive.sh`
- `ops/launchd/run-smartloop.sh`
- `ops/launchd/run-watchdog.sh`

## Install / Enable

Run once on macOS user session:

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
chmod +x ops/launchd/run-nearlive.sh ops/launchd/run-smartloop.sh ops/launchd/run-watchdog.sh

mkdir -p "$HOME/Library/LaunchAgents"
cp ops/launchd/com.neuropilot.nearlive.plist "$HOME/Library/LaunchAgents/"
cp ops/launchd/com.neuropilot.smartloop.plist "$HOME/Library/LaunchAgents/"
cp ops/launchd/com.neuropilot.watchdog.plist "$HOME/Library/LaunchAgents/"
cp ops/launchd/com.neuropilot.watchdog.smoketest.plist "$HOME/Library/LaunchAgents/"

launchctl unload "$HOME/Library/LaunchAgents/com.neuropilot.nearlive.plist" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.neuropilot.smartloop.plist" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.neuropilot.watchdog.plist" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.neuropilot.watchdog.smoketest.plist" 2>/dev/null || true

launchctl load "$HOME/Library/LaunchAgents/com.neuropilot.nearlive.plist"
launchctl load "$HOME/Library/LaunchAgents/com.neuropilot.smartloop.plist"
launchctl load "$HOME/Library/LaunchAgents/com.neuropilot.watchdog.plist"
launchctl load "$HOME/Library/LaunchAgents/com.neuropilot.watchdog.smoketest.plist"
```

## Baseline Policy

- `near-live`: guard and freshness policy active
  - `NEUROPILOT_CRITICAL_DATASETS=XAUUSD_5m,XAUUSD_1h`
  - `NEUROPILOT_PARTIAL_DEGRADE_ON_STALE=1`
- `smart-loop`: discovery unblock policy
  - `NEUROPILOT_DATA_GUARD_SKIP=0` (opt-out of degraded dataset skip for this process only)

## Health Check

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI" npm run ops:check-system-health
echo $?
```

Exit codes:

- `0` OK
- `1` warning
- `2` critical

## Watchdog (Ops Elite)

`engine/scripts/opsWatchdog.js` runs periodically and provides:

- auto-restart of dead `near-live` / `smart-loop` with `launchctl kickstart`
- Slack/Discord webhook alert when health check returns `exit=2`
- periodic health snapshots appended to `ops-snapshot/watchdog_health_history.jsonl`

Configuration via env:

- `NEUROPILOT_WATCHDOG_INTERVAL_SEC` (default `300`)
- `NEUROPILOT_WATCHDOG_WEBHOOK_URL` (or fallback `NEUROPILOT_OPS_ALERT_WEBHOOK_URL`)
- `NEUROPILOT_WATCHDOG_WEBHOOK_DISCORD=1` for Discord payload mode (`content`)
- `NEUROPILOT_WATCHDOG_ONE_SHOT=1` run a single cycle and exit
- `NEUROPILOT_WATCHDOG_FORCE_CRIT=1` force `exit=2` critical path for alert chain testing

### Controlled Alert Dry-Run (No Service Impact)

Goal: validate `health critical -> watchdog -> webhook -> logs/history` without stopping production services.

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2

# Optional: set explicit webhook for this test shell only.
# export NEUROPILOT_WATCHDOG_WEBHOOK_URL="https://hooks.slack.com/services/..."

npm run ops:watchdog:test-critical

# Verify watchdog logging and persisted snapshot
tail -n 80 logs/watchdog.out.log
tail -n 3 ops-snapshot/watchdog_health_history.jsonl
```

Expected:

- watchdog logs a cycle with `exit=2`
- webhook send attempt is logged (delivered or failed)
- one JSON line appended to `watchdog_health_history.jsonl` with `healthExitCode: 2`

### Daily Smoke Test (launchd)

The daily smoke test runs one forced critical watchdog cycle at `09:00` and exits.
It validates the full critical chain (`watchdog -> webhook -> logs/history`) continuously.

Install / verify:

```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuropilot_trading_v2
cp ops/launchd/com.neuropilot.watchdog.smoketest.plist "$HOME/Library/LaunchAgents/"
launchctl unload "$HOME/Library/LaunchAgents/com.neuropilot.watchdog.smoketest.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.neuropilot.watchdog.smoketest.plist"
launchctl list | rg "com\.neuropilot\.watchdog\.smoketest"
```

Manual trigger (without waiting 09:00):

```bash
launchctl kickstart -k gui/$(id -u)/com.neuropilot.watchdog.smoketest
tail -n 80 logs/watchdog_smoketest.out.log
tail -n 3 ops-snapshot/watchdog_health_history.jsonl
```

Webhook payload labeling:

- `[TEST]` when `NEUROPILOT_WATCHDOG_FORCE_CRIT=1`
- `[ALERT]` for real critical incidents

## Recovery Procedure

1. Check launchd state:
   - `launchctl list | rg "com.neuropilot.(nearlive|smartloop|watchdog|watchdog.smoketest)"`
2. Run health check:
   - `npm run ops:check-system-health`
3. Validate freshness:
   - Inspect `ops-snapshot/run_health.json` (`lastRunFinishedAt`, `staleDatasets`, `degradedCriticalDatasets`)
4. Validate dataset timestamps:
   - Inspect `datasets_manifest.json` keys `XAUUSD_5m` and `XAUUSD_1h` (`lastTs`)
5. If near-live is down, restart only near-live:
   - `launchctl kickstart -k gui/$(id -u)/com.neuropilot.nearlive`
6. If smart loop is blocked/down, restart only smart loop:
   - `launchctl kickstart -k gui/$(id -u)/com.neuropilot.smartloop`
7. Lock safety:
   - Never delete `.near_live_batch.lock` before verifying the PID inside is not alive.

## Logs

Service logs:

- `logs/nearlive.out.log`
- `logs/nearlive.err.log`
- `logs/smartloop.out.log`
- `logs/smartloop.err.log`
- `logs/watchdog.out.log`
- `logs/watchdog.err.log`
- `logs/watchdog_smoketest.out.log`
- `logs/watchdog_smoketest.err.log`

Operational logs/artifacts:

- `ops-snapshot/*`
- `$NEUROPILOT_DATA_ROOT/loop_logs/smart_loop_*.log`
- `ops-snapshot/watchdog_health_history.jsonl`
