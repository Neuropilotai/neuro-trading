#!/usr/bin/env node
'use strict';

/**
 * Evolution Monitoring Dashboard CLI — reads evolution_metrics.log (NDJSON).
 * Views: latest | trend [N] | alerts | milestones
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/evolution/scripts/evolutionDashboard.js latest
 *   node engine/evolution/scripts/evolutionDashboard.js trend 30
 *   node engine/evolution/scripts/evolutionDashboard.js alerts
 *   node engine/evolution/scripts/evolutionDashboard.js milestones
 */

const path = require('path');
const fs = require('fs');

const logPath = path.join(__dirname, '..', 'logs', 'evolution_metrics.log');
const DEFAULT_TREND_N = 20;

function loadLines() {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      // skip malformed
    }
  }
  return out;
}

function latest(rows) {
  if (rows.length === 0) {
    console.log('No data in evolution_metrics.log');
    return;
  }
  const r = rows[rows.length - 1];
  console.log(JSON.stringify({
    ts: r.ts,
    champions: r.champions,
    validated: r.validated,
    delta: r.delta,
    wildcardPromotions: r.wildcardPromotions,
    blockedGroupStronger: r.blockedGroupStronger,
    diversityCapped: r.diversityCapped,
    maxChampionsInOneFamily: r.maxChampionsInOneFamily,
    consistencyOk: r.consistencyOk,
  }, null, 2));
}

function trend(rows, n) {
  const slice = rows.slice(-Math.min(n, rows.length));
  if (slice.length === 0) {
    console.log('No data');
    return;
  }
  for (const r of slice) {
    console.log(JSON.stringify({
      ts: r.ts,
      champions: r.champions,
      validated: r.validated,
      delta: r.delta,
      wildcardPromotions: r.wildcardPromotions,
      blockedGroupStronger: r.blockedGroupStronger,
      diversityCapped: r.diversityCapped,
      maxChampionsInOneFamily: r.maxChampionsInOneFamily,
      consistencyOk: r.consistencyOk,
    }));
  }
}

function alerts(rows, n = 50) {
  const slice = rows.slice(-Math.min(n, rows.length));
  const issues = [];
  const DELTA_WARN = -0.003;
  const MAX_FAMILY_WARN = 4;

  for (let i = 0; i < slice.length; i++) {
    const r = slice[i];
    if (r.consistencyOk === false) {
      issues.push({ ts: r.ts, type: 'audit_ko' });
    }
    if (typeof r.delta === 'number' && r.delta < DELTA_WARN) {
      issues.push({ ts: r.ts, type: 'delta_low', delta: r.delta });
    }
    if (typeof r.maxChampionsInOneFamily === 'number' && r.maxChampionsInOneFamily > MAX_FAMILY_WARN) {
      issues.push({ ts: r.ts, type: 'diversity_drift', maxChampionsInOneFamily: r.maxChampionsInOneFamily });
    }
  }

  if (issues.length === 0) {
    console.log('No alerts in last', slice.length, 'runs');
    return;
  }
  console.log('Alerts (last', slice.length, 'runs):');
  for (const a of issues) {
    console.log(JSON.stringify(a));
  }
}

function milestones(rows) {
  if (rows.length === 0) {
    console.log('No data');
    return;
  }

  let firstWildcard = null;
  let bestDelta = null;
  let worstDelta = null;
  let worstDiversity = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if ((r.wildcardPromotions || 0) > 0 && firstWildcard == null) {
      firstWildcard = { ts: r.ts, wildcardPromotions: r.wildcardPromotions };
    }
    if (typeof r.delta === 'number') {
      if (bestDelta == null || r.delta > bestDelta.delta) bestDelta = { ts: r.ts, delta: r.delta };
      if (worstDelta == null || r.delta < worstDelta.delta) worstDelta = { ts: r.ts, delta: r.delta };
    }
    if (typeof r.maxChampionsInOneFamily === 'number') {
      if (worstDiversity == null || r.maxChampionsInOneFamily > worstDiversity.maxChampionsInOneFamily) {
        worstDiversity = { ts: r.ts, maxChampionsInOneFamily: r.maxChampionsInOneFamily };
      }
    }
  }

  console.log('Milestones:');
  console.log('  firstWildcardPromotions>0:', firstWildcard ? JSON.stringify(firstWildcard) : 'not yet');
  console.log('  bestDelta:               ', bestDelta ? JSON.stringify(bestDelta) : 'n/a');
  console.log('  worstDelta:              ', worstDelta ? JSON.stringify(worstDelta) : 'n/a');
  console.log('  worstDiversity (maxFam): ', worstDiversity ? JSON.stringify(worstDiversity) : 'n/a');
}

// --- main
const args = process.argv.slice(2);
const view = args[0] || 'latest';
const rows = loadLines();

switch (view) {
  case 'latest':
    latest(rows);
    break;
  case 'trend': {
    const n = parseInt(args[1], 10) || DEFAULT_TREND_N;
    trend(rows, n);
    break;
  }
  case 'alerts': {
    const n = parseInt(args[1], 10) || 50;
    alerts(rows, n);
    break;
  }
  case 'milestones':
    milestones(rows);
    break;
  default:
    console.error('Usage: evolutionDashboard.js <latest|trend [N]|alerts [N]|milestones>');
    process.exit(1);
}
