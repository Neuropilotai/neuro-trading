# Replay boost policy (desk-quant)

## Purpose

`replay_boost_policy.json` under `<DATA_ROOT>/governance/` is a **supervision-side allocation policy**: it prioritizes which setups deserve promoted-manifest replay budget, which should be throttled, and which should receive **zero** replay bars (frozen), using existing artefacts only (strict mapping, validation rows, setup analysis, health, circuit breaker, datasets freshness, convergence tail).

It does **not** replace `run_loop_auto.sh`, strict mapping, promote guards, or the simulator. Paper execution still requires valid signals and all existing throttles.

## Philosophy

- **No forced trades**: ordering and per-setup bar caps only.
- **Strict > learning**: baseline scoring from `replayBoostPolicy.js` emphasizes validation/strategy metrics; learning is a capped bonus in `replayBoostPolicyCore.js`.
- **`conservative` policyMode** tightens **globalControls** (max per run / setups / bars) and slightly lowers **weights** for boosted rows — it must **not** clamp the composite score below the boosted tier threshold, or `boostedCount` stays at zero while the JSON still looks “active”. Near-promote / strict **promoted_and_paper_recent** setups get a **bounded bonus** so overlap-band candidates can still become `boosted` when metrics justify it.
- **Health / breaker override**: when `circuit_breaker` or poor `neuropilot_health.json` status applies, `policyMode` tightens global caps and suppresses aggressive boosts.
- **Transparent**: every allocation row includes `reasons[]` and `metricsSnapshot`.
- **Reversible**: disable file policy at runtime with `NP_REPLAY_BOOST_POLICY_ENABLE=0` (falls back to the legacy in-process `computeReplayBoostPriority` path).

## Tiers

| Tier | Meaning |
|------|---------|
| `boosted` | Prefer replay budget within global caps |
| `neutral` | Normal handling |
| `throttled` | Lower bar caps, sort after boosted/neutral |
| `frozen` | `maxReplayBarsPerRun = 0` for replay boost path (persistent duplicate bypass gets `bars_per_setup_exhausted`) |

## Files

| Path | Role |
|------|------|
| `engine/governance/replayBoostPolicyCore.js` | Pure helpers: build policy, load file, execution mapping |
| `engine/governance/buildReplayBoostPolicy.js` | CLI: writes `replay_boost_policy.json` + `ops-snapshot/replay_boost_policy_build_status.json` |
| `engine/governance/run_replay_boost_policy_loop.sh` | Periodic rebuild (best-effort) |
| `<DATA_ROOT>/governance/replay_boost_policy.json` | Canonical policy snapshot |
| `runPaperExecutionV1.js` | If file valid and enable flag on: uses file for ordering + per-setup caps + global run caps |

## Environment

| Variable | Default | Notes |
|----------|---------|--------|
| `NP_REPLAY_BOOST_POLICY_ENABLE` | `1` | Set `0` to ignore file and use legacy scorer only |
| `NP_REPLAY_BOOST_POLICY_INTERVAL_SEC` | `120` | Policy loop sleep |
| `NP_REPLAY_BOOST_POLICY_MAX_GLOBAL_PER_RUN` | `24` | Upper bound for recommended bypasses per run (clamped with health) |
| `NP_REPLAY_BOOST_POLICY_MAX_SETUPS_PER_RUN` | `8` | Recommended max distinct setups per run |
| `NP_REPLAY_BOOST_POLICY_MAX_BARS_PER_SETUP` | `5` | Bar cap baseline for policy build |
| `NP_REPLAY_BOOST_POLICY_ALLOW_AGGRESSIVE` | `0` | Must be on for looser global caps in “normal” mode |
| `NP_REPLAY_BOOST_POLICY_*_WEIGHT` | see `replayBoostPolicyCore.js` | Tunables for duplicate/stall penalties and PF/expectancy/strict/learning |

`NEUROPILOT_PAPER_REPLAY_BOOST_ENABLE=1` and `NEUROPILOT_PAPER_ALLOW_PROMOTED_REPLAY=1` are still required for replay boost **and** file policy to apply at execution time.

## Supervisor integration

- `start_neuropilot_canonical.sh` can start `run_replay_boost_policy_loop.sh` (`NEUROPILOT_START_REPLAY_POLICY_LOOP=1`).
- PIDs are recorded in `logs/neuropilot_supervisor_stack.pids` (and mirrored to `logs/canonical_stack.pids`).
- `ops-snapshot/supervisor_status.json` gets `replayBoostPolicyLoopRunning` and `replayBoostPolicyLastBuildAt` when available.

## Operations

```bash
cd neuropilot_trading_v2
export NEUROPILOT_DATA_ROOT="/Volumes/TradingDrive/NeuroPilotAI"
export NEUROPILOT_OPS_SNAPSHOT_DIR="$PWD/ops-snapshot"
npm run governance:build-replay-boost-policy
npm run governance:show-replay-boost-top
```

Full stack (includes policy loop):

```bash
npm run governance:start-canonical
```

Stop:

```bash
npm run governance:stop-canonical
```

## Auditing a setup

```bash
jq '.allocations[] | select(.setupId=="YOUR_SETUP_ID")' \
  "$NEUROPILOT_DATA_ROOT/governance/replay_boost_policy.json"
```

Compare with last paper run:

```bash
jq '{replayBoostPolicyMode,replayBoostPolicyEnabled,replayBoostBoostedSeen,replayBoostBoostedUsed,replayBoostFrozenSkipped}' \
  "$NEUROPILOT_DATA_ROOT/governance/paper_exec_v1_last_run.json"
```

## Diagnostics

| Symptom | Check |
|---------|--------|
| Too many duplicates | `duplicateSkippedPersistent` in `paper_exec_v1_last_run.json`, `duplicate_pressure` reasons in policy |
| Long `effectiveAppended=0` | `neuropilot_health.json`, operator checkpoint, policy `policyMode` |
| Promote candidates not progressing | strict mapping report + convergence trend + policy tier (frozen?) |
| Boosted tier but no bypasses | smart allowlist / not_seen_7d / bar caps / `recommendedMaxPerRun` |
| Setup unexpectedly frozen | policy row `reasons`, `metricsSnapshot`, global `policyMode` |

## Disable

1. `export NP_REPLAY_BOOST_POLICY_ENABLE=0` (execution ignores file; legacy scorer if `NEUROPILOT_PAPER_REPLAY_BOOST_ENABLE=1`).
2. Optionally stop the policy loop: `NEUROPILOT_START_REPLAY_POLICY_LOOP=0` when starting canonical stack.
