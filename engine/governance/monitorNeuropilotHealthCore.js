#!/usr/bin/env node
'use strict';

/**
 * Desk-quant / incident commander health snapshot (read-only).
 * Writes neuropilot_health.*, incident_status.json; updates supervisor optional fields.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function tailText(p, maxBytes) {
  try {
    if (!fs.existsSync(p)) return '';
    const st = fs.statSync(p);
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function readJsonlLastN(p, n) {
  try {
    if (!fs.existsSync(p) || n < 1) return [];
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-n).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function toNum(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function isoAgeMinutes(iso) {
  if (!iso || typeof iso !== 'string') return -1;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return -1;
  return (Date.now() - t) / 60000;
}

function deriveOperatorLoopStatus(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return 'UNKNOWN';
  const v = checkpoint.verdict;
  const stale = checkpoint.strictMappingStaleVsLastRun === true;
  const r = toNum(checkpoint.metrics && checkpoint.metrics.promoted_and_paper_recent_count, 0);
  const ns = toNum(checkpoint.metrics && checkpoint.metrics.promoted_not_seen_in_paper_last_7d_count, 0);
  const d = checkpoint.trend && checkpoint.trend.delta_promoted_and_paper_recent;
  const dNum = d == null ? null : Number(d);

  if (v === 'REGRESSION' || stale || v === 'MISSING_STRICT_MAPPING' || v === 'MISSING_LAST_RUN') {
    return 'REGRESSION';
  }
  if ((dNum != null && dNum > 0) || (ns === 0 && r > 0)) {
    return 'HEALTHY_PROGRESS';
  }
  if (v === 'NO_PROGRESS' || v === 'BYPASS_ACTIVE_WAITING' || v === 'BYPASS_OFF') {
    return 'STAGNATING';
  }
  if (v === 'OK' && ns > 0) return 'STABLE_OK';
  if (v === 'OK') return 'STABLE_OK';
  return 'STABLE_OK';
}

function countDatasetStatuses(doc) {
  const out = { degraded: 0, critical: 0, lagging: 0, healthy: 0 };
  const rows = doc && Array.isArray(doc.datasets) ? doc.datasets : [];
  for (const row of rows) {
    const s = row && row.status != null ? String(row.status).toLowerCase() : '';
    if (s === 'degraded') out.degraded += 1;
    else if (s === 'critical') out.critical += 1;
    else if (s === 'lagging') out.lagging += 1;
    else if (s === 'healthy') out.healthy += 1;
  }
  return out;
}

function loadCheckpoint(repoRoot, dataRoot) {
  const script = path.join(repoRoot, 'engine/governance/checkPromotedRecentCheckpoint.js');
  try {
    const out = execFileSync(process.execPath, [script, '--json'], {
      cwd: repoRoot,
      env: { ...process.env, NEUROPILOT_DATA_ROOT: dataRoot },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(out.trim());
  } catch {
    return null;
  }
}

function restartsLastHourFromWatchdog(wd) {
  const arr = wd && Array.isArray(wd.restartHistory) ? wd.restartHistory : [];
  const h = Date.now() - 3600000;
  return arr.filter((x) => {
    const t = Date.parse(x);
    return Number.isFinite(t) && t >= h;
  }).length;
}

function extractOperatorLines(loopTail) {
  const lines = loopTail.split('\n').filter((l) => l.includes('OPERATOR_LOOP_STATUS='));
  return lines.slice(-5);
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const dataRoot = process.env.NEUROPILOT_DATA_ROOT
    ? path.resolve(process.env.NEUROPILOT_DATA_ROOT)
    : path.join(repoRoot, 'data_workspace');
  const opsDir = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR
    ? path.resolve(process.env.NEUROPILOT_OPS_SNAPSHOT_DIR)
    : path.join(repoRoot, 'ops-snapshot');
  const gov = path.join(dataRoot, 'governance');

  const lastRunPath = path.join(gov, 'paper_exec_v1_last_run.json');
  const strictPath = path.join(gov, 'paper_trades_strict_mapping_report.json');
  const analysisPath = path.join(gov, 'paper_trades_by_setup_analysis.json');
  const trendPath = path.join(gov, 'promoted_convergence_trend.jsonl');
  const dsGov = path.join(gov, 'datasets_freshness.json');
  const execGov = path.join(gov, 'execution_status.json');
  const dashPath = path.join(opsDir, 'governance_dashboard.json');
  const ownerDashPath = path.join(opsDir, 'owner_ops_dashboard.json');
  const execSnap = path.join(opsDir, 'execution_status.json');
  const dsSnap = path.join(opsDir, 'datasets_freshness.json');
  const loopLogPath = path.join(repoRoot, 'logs', 'run_loop_auto.log');
  const watchdogLogPath = path.join(repoRoot, 'logs', 'watchdog_neuropilot.log');
  const supPath = path.join(opsDir, 'supervisor_status.json');
  const wdPath = path.join(opsDir, 'watchdog_status.json');
  const cbPath = path.join(opsDir, 'circuit_breaker_status.json');
  const alertStatePath = path.join(opsDir, 'alert_state.json');

  const lastRun = safeReadJson(lastRunPath) || {};
  const strict = safeReadJson(strictPath) || {};
  const analysis = safeReadJson(analysisPath) || {};
  const dsDoc = safeReadJson(dsGov) || safeReadJson(dsSnap) || {};
  const execDoc = safeReadJson(execGov) || safeReadJson(execSnap) || {};
  const dash = safeReadJson(dashPath) || {};
  const ownerDash = safeReadJson(ownerDashPath);
  const supervisor = safeReadJson(supPath) || {};
  const watchdog = safeReadJson(wdPath) || {};
  const circuitBreaker = safeReadJson(cbPath) || { state: 'CLOSED' };
  const alertState = safeReadJson(alertStatePath) || {};

  const trendLines = readJsonlLastN(trendPath, 4);
  let trendFlatOverlap = false;
  if (trendLines.length >= 2) {
    const a = toNum(trendLines[trendLines.length - 2].promoted_and_paper_recent, -1);
    const b = toNum(trendLines[trendLines.length - 1].promoted_and_paper_recent, -2);
    trendFlatOverlap = a === b && a >= 0;
  }

  const loopTail = tailText(loopLogPath, 12000);
  const watchdogTail = tailText(watchdogLogPath, 8000);
  const operatorLogLines = extractOperatorLines(loopTail);

  const checkpoint = loadCheckpoint(repoRoot, dataRoot);
  const operatorLoopStatusLatest = deriveOperatorLoopStatus(checkpoint);

  const promotedRecent = Array.isArray(strict.promoted_and_paper_recent)
    ? strict.promoted_and_paper_recent.length
    : 0;
  const promotedNotSeen = Array.isArray(strict.promoted_not_seen_in_paper_last_7d)
    ? strict.promoted_not_seen_in_paper_last_7d.length
    : 0;

  const dsCounts = countDatasetStatuses(dsDoc);
  const dashAgeMin = isoAgeMinutes(dash.generatedAt);
  const lastRunAgeMin = isoAgeMinutes(lastRun.writtenAt);
  const effectiveAppended = toNum(lastRun.effectiveAppended, 0);
  const dupPersistent = toNum(lastRun.duplicateSkippedPersistent, 0);

  const brokerConnected =
    execDoc.brokerConnected === true || execDoc.brokerConnected === false
      ? execDoc.brokerConnected
      : null;
  const executionMode = execDoc.mode != null ? String(execDoc.mode) : null;
  const killSwitch = execDoc.killSwitchOn === true;

  const restartsLastHour = restartsLastHourFromWatchdog(watchdog);
  const maxRestarts = toNum(process.env.NP_WATCHDOG_MAX_RESTARTS_PER_HOUR, 6);
  const restartPressure = {
    restartsLastHour,
    maxPerHour: maxRestarts,
    backoffSuggested: restartsLastHour >= Math.max(1, maxRestarts - 1),
    watchdogEscalation: watchdog.circuitBreakerEscalation === true,
  };

  const slackOn = !!(process.env.NP_SLACK_WEBHOOK_URL && String(process.env.NP_SLACK_WEBHOOK_URL).trim());
  const tgOn = !!(
    process.env.NP_TELEGRAM_BOT_TOKEN &&
    process.env.NP_TELEGRAM_CHAT_ID &&
    String(process.env.NP_TELEGRAM_BOT_TOKEN).trim() &&
    String(process.env.NP_TELEGRAM_CHAT_ID).trim()
  );
  const alertTargetsConfigured = { slack: slackOn, telegram: tgOn };
  const lastAlertSentAt = alertState.lastAlertSentAt || null;

  const circuitBreakerActive = String(circuitBreaker.state || 'CLOSED').toUpperCase() !== 'CLOSED';

  const staleFlags = [];
  if (!fs.existsSync(lastRunPath)) staleFlags.push('missing_paper_exec_v1_last_run');
  if (lastRunAgeMin < 0) staleFlags.push('last_run_timestamp_invalid');
  else if (lastRunAgeMin > 60) staleFlags.push('paper_last_run_very_stale');

  const strictGen = Date.parse(strict.generatedAt || '');
  const lastW = Date.parse(lastRun.writtenAt || '');
  if (Number.isFinite(strictGen) && Number.isFinite(lastW) && lastW > strictGen + 1000) {
    staleFlags.push('strict_mapping_stale_vs_last_paper_run');
  }

  if (dashAgeMin < 0) staleFlags.push('dashboard_generatedAt_missing');
  else if (dashAgeMin > 120) staleFlags.push('governance_dashboard_stale');

  if (dsCounts.critical >= 1) staleFlags.push('datasets_critical_present');
  if (dsCounts.degraded >= 10) staleFlags.push('datasets_massively_degraded');
  if (dsCounts.lagging >= 15) staleFlags.push('datasets_lagging_elevated');

  if (executionMode === 'live' && killSwitch) staleFlags.push('kill_switch_on_live_context');
  if (executionMode === 'live' && brokerConnected === false) {
    staleFlags.push('live_broker_disconnected');
  }

  if (trendFlatOverlap && promotedNotSeen > 5) staleFlags.push('promoted_overlap_flat_in_trend');

  const replayPolicyPath = path.join(gov, 'replay_boost_policy.json');
  const replayPolicy = safeReadJson(replayPolicyPath);
  const replayBoostPolicyPresent =
    replayPolicy != null && Number(replayPolicy.schemaVersion) === 1;
  const replayBoostPolicyMode = replayBoostPolicyPresent ? replayPolicy.policyMode || null : null;
  const boostedCountPolicy = replayBoostPolicyPresent && replayPolicy.summary
    ? toNum(replayPolicy.summary.boostedCount, 0)
    : null;
  const frozenCountPolicy = replayBoostPolicyPresent && replayPolicy.summary
    ? toNum(replayPolicy.summary.frozenCount, 0)
    : null;
  const recommendedMaxPerRunPolicy =
    replayBoostPolicyPresent && replayPolicy.globalControls
      ? replayPolicy.globalControls.recommendedMaxPerRun
      : null;
  const replayPolicyAgeMin = replayBoostPolicyPresent ? isoAgeMinutes(replayPolicy.generatedAt) : -1;
  const replayPolicyExpected = !['0', 'false', 'no', 'off'].includes(
    String(process.env.NP_REPLAY_BOOST_POLICY_ENABLE || '1')
      .trim()
      .toLowerCase()
  );
  let replayBoostPolicyWarning = null;
  if (replayPolicyExpected && !replayBoostPolicyPresent) {
    replayBoostPolicyWarning = 'replay_boost_policy.json missing under governance/ (expected when policy enabled)';
    staleFlags.push('replay_boost_policy_missing');
  } else if (replayBoostPolicyPresent && replayPolicyAgeMin > 45) {
    replayBoostPolicyWarning = 'replay_boost_policy.json older than ~45 minutes — run build or policy loop';
    staleFlags.push('replay_boost_policy_stale');
  }

  const autoThrottlePath = path.join(gov, 'auto_throttle_policy.json');
  const autoThrottlePol = safeReadJson(autoThrottlePath);
  const autoThrottlePolicyPresent =
    autoThrottlePol != null && Number(autoThrottlePol.schemaVersion) === 1;
  const atSummary = autoThrottlePolicyPresent && autoThrottlePol.summary ? autoThrottlePol.summary : null;
  const atCand = atSummary ? toNum(atSummary.candidateCount, 0) : 0;
  const atFrozen = atSummary ? toNum(atSummary.frozenCount, 0) : 0;
  const atThrottle = atSummary ? toNum(atSummary.throttleCount, 0) : 0;
  const atProtect = atSummary ? toNum(atSummary.protectCount, 0) : 0;
  const autoThrottleFrozenShare =
    autoThrottlePolicyPresent && atCand > 0 ? atFrozen / atCand : null;
  const autoThrottlePolicyAgeMin = autoThrottlePolicyPresent ? isoAgeMinutes(autoThrottlePol.generatedAt) : -1;
  let autoThrottleKillPressure = false;
  let autoThrottleKillPressureReason = null;
  if (autoThrottleFrozenShare != null && autoThrottleFrozenShare > 0.28) {
    autoThrottleKillPressure = true;
    autoThrottleKillPressureReason = 'frozen_share_above_28pct';
    staleFlags.push('auto_throttle_frozen_share_elevated');
  } else if (autoThrottlePolicyPresent && atCand > 8 && atThrottle / atCand > 0.55) {
    autoThrottleKillPressure = true;
    autoThrottleKillPressureReason = 'throttle_share_above_55pct';
  }

  const capitalPath = path.join(gov, 'capital_allocation_policy.json');
  const capitalPol = safeReadJson(capitalPath);
  const capitalAllocationPolicyPresent =
    capitalPol != null && Number(capitalPol.schemaVersion) === 1;
  const capSummary =
    capitalAllocationPolicyPresent && capitalPol.summary ? capitalPol.summary : null;
  const capCand = capSummary ? toNum(capSummary.candidateCount, 0) : 0;
  const capCor =
    capitalAllocationPolicyPresent && capitalPol.concentrationRisk
      ? capitalPol.concentrationRisk
      : null;
  let allocationPressure = null;
  if (capitalAllocationPolicyPresent && capSummary && capCand > 0) {
    const sus = toNum(capSummary.suspendedCount, 0);
    const red = toNum(capSummary.reducedCount, 0);
    allocationPressure = Math.round(((sus + red) / capCand) * 1000) / 1000;
  }
  let capitalConcentrationHigh = false;
  if (capCor != null) {
    const hhi = toNum(capCor.herfindahlFamily, 0);
    const topFam = toNum(capCor.topFamilyShare, 0);
    if (hhi > 0.42 || topFam > 0.62) capitalConcentrationHigh = true;
  }
  const capitalAllocationPressureHigh =
    allocationPressure != null && allocationPressure > 0.55;

  let overallStatus = 'HEALTHY';
  const concerns = [];

  if (!fs.existsSync(lastRunPath) || !fs.existsSync(strictPath)) {
    overallStatus = 'CRITICAL';
    concerns.push('Missing core governance artefacts (last run or strict mapping).');
  } else if (circuitBreakerActive && String(circuitBreaker.state) === 'OPEN') {
    overallStatus = 'CRITICAL';
    concerns.push(`Circuit breaker OPEN (${circuitBreaker.reason || 'unknown'}).`);
  } else if (restartsLastHour >= maxRestarts) {
    overallStatus = 'CRITICAL';
    concerns.push(`Restart pressure: ${restartsLastHour} restarts in last hour (max ${maxRestarts}).`);
  } else if (
    staleFlags.includes('strict_mapping_stale_vs_last_paper_run') &&
    lastRunAgeMin > 20
  ) {
    overallStatus = 'CRITICAL';
    concerns.push('Strict mapping stale vs paper run — overlap metrics unreliable.');
  } else if (dashAgeMin > 180) {
    overallStatus = 'CRITICAL';
    concerns.push('Governance dashboard export critically stale.');
  } else if (executionMode === 'live' && brokerConnected === false) {
    overallStatus = 'CRITICAL';
    concerns.push('Live mode but broker not connected.');
  } else if (dsCounts.critical >= 2) {
    overallStatus = 'DEGRADED';
    concerns.push('Multiple datasets in critical freshness state.');
  } else if (dsCounts.degraded >= 10 || promotedNotSeen > 18) {
    overallStatus = 'DEGRADED';
    concerns.push('Heavy dataset degradation or large promoted-not-seen backlog.');
  } else if (trendFlatOverlap && operatorLoopStatusLatest === 'STAGNATING') {
    overallStatus = 'DEGRADED';
    concerns.push('Promoted overlap flat in trend while operator stagnating.');
  } else if (operatorLoopStatusLatest === 'REGRESSION' || staleFlags.includes('governance_dashboard_stale')) {
    overallStatus = 'DEGRADED';
    concerns.push('Regression operator status or dashboard lag.');
  } else if (
    operatorLoopStatusLatest === 'STAGNATING' &&
    effectiveAppended === 0 &&
    toNum(lastRun.promotedReplayBypassCount, 0) === 0
  ) {
    overallStatus = 'STALLED';
    concerns.push('Stagnating operator, no append, no replay bypass this run.');
  } else if (lastRunAgeMin > 35 || dsCounts.degraded >= 6 || staleFlags.length > 0) {
    overallStatus = 'WATCH';
    concerns.push('Elevated lag/staleness — tighten monitoring.');
  }

  if (autoThrottleKillPressure && overallStatus === 'HEALTHY') {
    overallStatus = 'WATCH';
    concerns.push(
      `Auto-throttle kill pressure (${autoThrottleKillPressureReason || 'unknown'}): frozen=${atFrozen}/${atCand} throttle=${atThrottle} protect=${atProtect}.`
    );
  }

  if (capitalConcentrationHigh) {
    staleFlags.push('capital_allocation_concentration_elevated');
  }
  if (capitalAllocationPressureHigh) {
    staleFlags.push('capital_allocation_pressure_elevated');
  }
  if (
    capitalConcentrationHigh &&
    (overallStatus === 'HEALTHY' || overallStatus === 'WATCH')
  ) {
    if (overallStatus === 'HEALTHY') {
      overallStatus = 'WATCH';
      concerns.push('Capital allocation concentration risk elevated (family HHI / top share).');
    } else {
      overallStatus = 'DEGRADED';
      concerns.push('Capital allocation concentration persisting under WATCH — escalate review.');
    }
  } else if (capitalAllocationPressureHigh && overallStatus === 'HEALTHY') {
    overallStatus = 'WATCH';
    concerns.push('Capital allocation pressure elevated (reduced + suspended share).');
  }

  if (concerns.length === 0) {
    concerns.push('No major anomalies under aggressive desk-quant rules.');
  }

  const topConcerns = concerns.slice(0, 10);

  let incidentSeverity = 'none';
  if (overallStatus === 'CRITICAL') incidentSeverity = 'critical';
  else if (overallStatus === 'DEGRADED' || overallStatus === 'STALLED') incidentSeverity = 'warn';
  else if (overallStatus === 'WATCH') incidentSeverity = 'info';

  let incidentMode = 'normal';
  if (circuitBreakerActive) incidentMode = 'circuit_breaker';
  else if (overallStatus === 'CRITICAL') incidentMode = 'incident';
  else if (overallStatus === 'DEGRADED' || overallStatus === 'STALLED') incidentMode = 'elevated';

  const drShort = path.basename(dataRoot);
  const fpPayload = `${overallStatus}|${topConcerns[0] || ''}|${drShort}|${operatorLoopStatusLatest}`;
  const incidentFingerprint = crypto.createHash('sha256').update(fpPayload).digest('hex').slice(0, 16);

  let recommendedAction =
    'Maintain watch; export ops snapshot if dashboard age drifts; confirm Wave1 + DATA_ROOT.';
  if (overallStatus === 'CRITICAL' || incidentMode === 'circuit_breaker') {
    recommendedAction =
      'Incident commander: inspect circuit_breaker_status.json, staleFlags, restartPressure; avoid blind restarts; run governance:promoted-paper-7d-loop once in foreground if safe.';
  } else if (overallStatus === 'STALLED') {
    recommendedAction =
      'Audit promoted replay bypass + strict mapping; review run_loop_auto.log operator lines.';
  } else if (overallStatus === 'WATCH') {
    recommendedAction = 'Increase sampling; run refresh + checkpoint JSON.';
  }
  if (autoThrottleKillPressure && overallStatus !== 'CRITICAL') {
    recommendedAction = `${recommendedAction} Review governance/auto_throttle_policy.json and replay budgets (killPressure).`;
  }
  if (
    (capitalConcentrationHigh || capitalAllocationPressureHigh) &&
    overallStatus !== 'CRITICAL'
  ) {
    recommendedAction = `${recommendedAction} Review governance/capital_allocation_policy.json and replay budget caps.`;
  }

  const outJson = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    repoRoot,
    dataRoot,
    opsSnapshotDir: opsDir,
    overallStatus,
    incidentSeverity,
    incidentMode,
    operatorLoopStatusLatest,
    operatorLoopStatusLogSample: operatorLogLines,
    checkpointVerdict: checkpoint && checkpoint.verdict != null ? checkpoint.verdict : null,
    lastRunWrittenAt: lastRun.writtenAt || null,
    effectiveAppended,
    duplicateSkippedPersistent: dupPersistent,
    promotedAndPaperRecent: promotedRecent,
    promotedNotSeenInPaperLast7d: promotedNotSeen,
    datasetsDegradedCount: dsCounts.degraded,
    datasetsLaggingCount: dsCounts.lagging,
    datasetsCriticalCount: dsCounts.critical,
    executionBrokerConnected: brokerConnected,
    executionMode,
    dashboardGeneratedAt: dash.generatedAt || null,
    ownerOpsDashboardPresent: fs.existsSync(ownerDashPath),
    ownerOpsDashboardSummaryPresent: ownerDash != null,
    staleFlags,
    recommendedAction,
    topConcerns,
    restartPressure,
    circuitBreakerActive,
    circuitBreakerState: circuitBreaker.state || 'CLOSED',
    alertTargetsConfigured,
    lastAlertSentAt,
    incidentFingerprint,
    loopLogPresent: fs.existsSync(loopLogPath),
    watchdogLogPresent: fs.existsSync(watchdogLogPath),
    watchdogLogTailBytes: watchdogTail ? Math.min(watchdogTail.length, 8000) : 0,
    supervisorStatusSnapshot: supervisor.supervisorStatus || null,
    joinDiagnosticsRecent7d:
      analysis.joinDiagnostics && analysis.joinDiagnostics.recent_7d != null
        ? analysis.joinDiagnostics.recent_7d
        : null,
    trendSnapshotsUsed: trendLines.length,
    replayBoostPolicyPresent,
    replayBoostPolicyMode,
    replayBoostPolicyBoostedCount: boostedCountPolicy,
    replayBoostPolicyFrozenCount: frozenCountPolicy,
    replayBoostRecommendedMaxPerRun: recommendedMaxPerRunPolicy,
    replayBoostPolicyAgeMinutes: replayBoostPolicyPresent ? replayPolicyAgeMin : null,
    replayBoostPolicyWarning,
    autoThrottleActive: autoThrottlePolicyPresent,
    autoThrottlePolicyMode: autoThrottlePolicyPresent ? autoThrottlePol.policyMode || null : null,
    autoThrottleFrozenCount: autoThrottlePolicyPresent ? atFrozen : null,
    autoThrottleThrottleCount: autoThrottlePolicyPresent ? atThrottle : null,
    autoThrottleProtectCount: autoThrottlePolicyPresent ? atProtect : null,
    autoThrottleCandidateCount: autoThrottlePolicyPresent ? atCand : null,
    autoThrottleFrozenShare: autoThrottleFrozenShare,
    autoThrottlePolicyAgeMinutes: autoThrottlePolicyPresent ? autoThrottlePolicyAgeMin : null,
    killPressure: autoThrottleKillPressure,
    killPressureReason: autoThrottleKillPressureReason,
    capitalAllocationActive: capitalAllocationPolicyPresent,
    capitalAllocationCoreCount:
      capitalAllocationPolicyPresent && capSummary ? toNum(capSummary.coreCount, 0) : null,
    capitalAllocationReducedCount:
      capitalAllocationPolicyPresent && capSummary ? toNum(capSummary.reducedCount, 0) : null,
    capitalAllocationSuspendedCount:
      capitalAllocationPolicyPresent && capSummary ? toNum(capSummary.suspendedCount, 0) : null,
    capitalAllocationConcentrationRisk: capCor,
    allocationPressure,
  };

  fs.mkdirSync(opsDir, { recursive: true });
  const jsonPath = path.join(opsDir, 'neuropilot_health.json');
  fs.writeFileSync(jsonPath, JSON.stringify(outJson, null, 2), 'utf8');

  const mdPath = path.join(opsDir, 'neuropilot_health.md');
  const md = `# NeuroPilot health (desk quant)

- **generatedAt**: ${outJson.generatedAt}
- **overallStatus**: **${overallStatus}**
- **incidentSeverity**: ${incidentSeverity}
- **incidentMode**: ${incidentMode}
- **circuitBreakerState**: ${outJson.circuitBreakerState} (active=${circuitBreakerActive})
- **incidentFingerprint**: \`${incidentFingerprint}\`
- **operatorLoopStatusLatest**: ${operatorLoopStatusLatest}
- **checkpoint verdict**: ${outJson.checkpointVerdict || 'n/a'}
- **lastRunWrittenAt**: ${outJson.lastRunWrittenAt || 'n/a'}
- **effectiveAppended**: ${effectiveAppended}
- **duplicateSkippedPersistent**: ${dupPersistent}
- **promotedAndPaperRecent**: ${promotedRecent}
- **promotedNotSeenInPaperLast7d**: ${promotedNotSeen}
- **datasets**: degraded=${dsCounts.degraded} lagging=${dsCounts.lagging} critical=${dsCounts.critical}
- **execution**: mode=${executionMode || 'unknown'} brokerConnected=${String(brokerConnected)}
- **restartPressure**: ${restartsLastHour}/${maxRestarts} per hour
- **dashboardGeneratedAt**: ${outJson.dashboardGeneratedAt || 'n/a'}
- **hooks**: slack=${slackOn} telegram=${tgOn}
- **replay boost policy**: present=${replayBoostPolicyPresent} mode=${replayBoostPolicyMode || 'n/a'} boosted=${boostedCountPolicy != null ? boostedCountPolicy : 'n/a'} frozen=${frozenCountPolicy != null ? frozenCountPolicy : 'n/a'} max/run=${recommendedMaxPerRunPolicy != null ? recommendedMaxPerRunPolicy : 'n/a'}
- **replay policy warning**: ${replayBoostPolicyWarning || '(none)'}
- **auto-throttle policy**: active=${autoThrottlePolicyPresent} mode=${outJson.autoThrottlePolicyMode || 'n/a'} frozen=${atFrozen}/${atCand || 0} throttle=${atThrottle} protect=${atProtect} killPressure=${autoThrottleKillPressure}
- **capital allocation policy**: active=${capitalAllocationPolicyPresent} core=${outJson.capitalAllocationCoreCount != null ? outJson.capitalAllocationCoreCount : 'n/a'} reduced=${outJson.capitalAllocationReducedCount != null ? outJson.capitalAllocationReducedCount : 'n/a'} suspended=${outJson.capitalAllocationSuspendedCount != null ? outJson.capitalAllocationSuspendedCount : 'n/a'} allocationPressure=${allocationPressure != null ? allocationPressure : 'n/a'}

## Stale flags
${staleFlags.length ? staleFlags.map((s) => `- ${s}`).join('\n') : '- (none)'}

## Top concerns
${topConcerns.map((c) => `- ${c}`).join('\n')}

## Recommended action
${recommendedAction}
`;
  fs.writeFileSync(mdPath, md, 'utf8');

  const incidentPath = path.join(opsDir, 'incident_status.json');
  const incidentDoc = {
    schemaVersion: 1,
    generatedAt: outJson.generatedAt,
    incidentFingerprint,
    incidentSeverity,
    incidentMode,
    overallStatus,
    circuitBreakerState: outJson.circuitBreakerState,
    topConcerns: topConcerns.slice(0, 5),
    recommendedAction,
    restartPressure,
    alertTargetsConfigured,
  };
  fs.writeFileSync(incidentPath, JSON.stringify(incidentDoc, null, 2), 'utf8');

  if (fs.existsSync(supPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(supPath, 'utf8'));
      if (s.supervisorStatus === 'STOPPED') {
        /* do not revive stopped stack via health writer */
      } else {
        s.lastHealthCheckAt = new Date().toISOString();
        s.lastOverallHealthStatus = overallStatus;
        s.incidentMode = incidentMode;
        s.circuitBreakerState = outJson.circuitBreakerState;
        s.alertTargetsConfigured = alertTargetsConfigured;
        if (circuitBreakerActive) s.supervisorStatus = 'CIRCUIT_BREAKER_OPEN';
        else if (overallStatus === 'CRITICAL') s.supervisorStatus = 'DEGRADED';
        else if (overallStatus === 'DEGRADED' || overallStatus === 'STALLED') s.supervisorStatus = 'DEGRADED';
        else if (overallStatus === 'WATCH') s.supervisorStatus = 'WATCHING';
        else s.supervisorStatus = 'RUNNING';
        fs.writeFileSync(supPath, JSON.stringify(s, null, 2), 'utf8');
      }
    } catch {
      /* ignore */
    }
  }

  console.log(JSON.stringify({ ok: true, jsonPath, mdPath, incidentPath, overallStatus, incidentMode }));
}

if (require.main === module) {
  main();
}

module.exports = { main, deriveOperatorLoopStatus };
