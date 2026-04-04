#!/usr/bin/env node
'use strict';

/**
 * Evolution Monitoring Dashboard CLI — lit evolution_metrics.log (NDJSON).
 * Modes: latest | trend [N] | alerts | milestones | live [intervalSec] [points]
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/evolution/monitor.js latest
 *   node engine/evolution/monitor.js trend 20
 *   node engine/evolution/monitor.js alerts
 *   node engine/evolution/monitor.js milestones
 *   node engine/evolution/monitor.js live           # refresh 5s, 20 points
 *   node engine/evolution/monitor.js live 5        # refresh 5s
 *   node engine/evolution/monitor.js live 2 40    # refresh 2s, 40 points
 */

const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, 'logs', 'evolution_metrics.log');

function loadData() {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const raw = fs.readFileSync(logPath, 'utf8').trim();
  const lines = raw ? raw.split('\n').filter(Boolean) : [];
  const data = [];
  for (const line of lines) {
    try {
      data.push(JSON.parse(line));
    } catch (_) {
      // skip malformed
    }
  }
  return data;
}

const data = loadData();
const mode = process.argv[2] || 'latest';
const arg = Number(process.argv[3]);
const last = data.length > 0 ? data[data.length - 1] : null;

// ---------- LATEST ----------
if (mode === 'latest') {
  if (!last) {
    console.error('No log file or empty log.');
    process.exit(1);
  }
  console.log(JSON.stringify({
    ts: last.ts,
    champions: last.champions,
    validated: last.validated,
    delta: last.delta,
    wildcardPromotions: last.wildcardPromotions,
    diversityCapped: last.diversityCapped,
    maxChampionsInOneFamily: last.maxChampionsInOneFamily,
    consistencyOk: last.consistencyOk,
  }, null, 2));
}

// ---------- TREND ----------
else if (mode === 'trend') {
  const N = Number.isFinite(arg) && arg > 0 ? arg : 20;
  const slice = data.slice(-N);
  if (slice.length === 0) {
    console.error('No data.');
    process.exit(1);
  }
  console.log('TS                  Δ        WC   CH   VAL');
  console.log('-------------------------------------------');
  for (const r of slice) {
    const ts = (r.ts && String(r.ts).length >= 19) ? r.ts.slice(11, 19) : (r.ts || '');
    const delta = (r.delta != null ? Number(r.delta) : 0).toFixed(4);
    const wc = String(r.wildcardPromotions ?? 0);
    const ch = String(r.champions ?? '');
    const val = String(r.validated ?? '');
    console.log(`${ts.padEnd(18)} ${delta.padStart(8)} ${wc.padEnd(4)} ${ch.padEnd(4)} ${val}`);
  }
}

// ---------- ALERTS ----------
else if (mode === 'alerts') {
  const ALERT_DELTA = -0.003;
  const ALERT_WILDCARD_RUNS = 10;
  const ALERT_MAX_FAMILY = 4;

  const lastN = data.slice(-Math.max(ALERT_WILDCARD_RUNS, 1));
  const delta = last ? (last.delta ?? 0) : 0;
  const wcInactive = lastN.length >= ALERT_WILDCARD_RUNS &&
    lastN.every((r) => (r.wildcardPromotions || 0) === 0);
  const maxFamily = last ? (last.maxChampionsInOneFamily || 0) : 0;

  if (delta < ALERT_DELTA) {
    console.log(`[ALERT] Delta fortement négatif (${delta})`);
  } else {
    console.log('[OK] Delta acceptable');
  }

  if (wcInactive) {
    console.log(`[ALERT] Wildcard inactif sur ${lastN.length} runs`);
  } else {
    console.log('[OK] Wildcard actif ou peu de runs');
  }

  if (maxFamily > ALERT_MAX_FAMILY) {
    console.log(`[ALERT] Concentration famille élevée (${maxFamily})`);
  } else {
    console.log('[OK] Diversité stable');
  }

  if (last && last.consistencyOk === false) {
    console.log('[ALERT] Audit FAILED');
  } else {
    console.log('[OK] Audit OK');
  }
}

// ---------- MILESTONES ----------
else if (mode === 'milestones') {
  if (data.length === 0) {
    console.error('No data.');
    process.exit(1);
  }

  const firstWildcard = data.find((r) => (r.wildcardPromotions || 0) > 0);
  const deltas = data.map((r) => r.delta).filter((d) => d != null && Number.isFinite(d));
  const bestDelta = deltas.length ? Math.max(...deltas) : null;
  const worstDelta = deltas.length ? Math.min(...deltas) : null;
  const maxChampions = Math.max(...data.map((r) => r.champions || 0));
  const maxFamily = Math.max(...data.map((r) => r.maxChampionsInOneFamily || 0));

  console.log(`First wildcard promotion: ${firstWildcard ? firstWildcard.ts : 'none'}`);
  console.log(`Best delta: ${bestDelta != null ? (bestDelta >= 0 ? '+' : '') + bestDelta : 'n/a'}`);
  console.log(`Worst delta: ${worstDelta != null ? worstDelta : 'n/a'}`);
  console.log(`Max champions: ${maxChampions}`);
  console.log(`Max family concentration: ${maxFamily}`);
}

// ---------- LIVE ----------
else if (mode === 'live') {
  const intervalSec = Number(process.argv[3]) || 5;
  const points = Number(process.argv[4]) || 20;

  const spark = (values) => {
    if (values.length === 0) return '';
    const chars = '▁▂▃▄▅▆▇█';
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return '▁'.repeat(values.length);
    return values
      .map((v) => {
        const norm = (v - min) / (max - min);
        const idx = Math.min(Math.floor(norm * (chars.length - 1)), chars.length - 1);
        return chars[idx];
      })
      .join('');
  };

  const render = () => {
    if (!fs.existsSync(logPath)) return;
    const data = loadData();
    if (data.length === 0) return;

    const slice = data.slice(-points);
    if (slice.length === 0) return;
    const deltas = slice.map((r) => r.delta ?? 0);
    const last = slice[slice.length - 1];

    process.stdout.write('\x1Bc');
    console.log(`NEUROPILOT EVOLUTION LIVE (refresh ${intervalSec}s)\n`);
    console.log(`Delta Trend (last ${points})`);
    console.log(spark(deltas));
    console.log('');
    console.log('Latest:');
    console.log(`delta: ${(last.delta != null ? Number(last.delta) : 0).toFixed(4)}`);
    console.log(`champions: ${last.champions ?? ''}`);
    console.log(`validated: ${last.validated ?? ''}`);
    console.log(`wildcardPromotions: ${last.wildcardPromotions ?? 0}`);
    console.log('');
    console.log('Status:');

    const d = last.delta != null ? Number(last.delta) : 0;
    if (d < -0.003) {
      console.log('ALERT delta strongly negative');
    } else if (d < 0) {
      console.log('OK delta slightly negative');
    } else {
      console.log('GOOD delta positive');
    }

    if ((last.maxChampionsInOneFamily || 0) > 4) {
      console.log('ALERT diversity drift');
    } else {
      console.log('OK diversity stable');
    }

    if (last.consistencyOk === false) {
      console.log('ALERT audit failed');
    } else {
      console.log('OK audit');
    }
  };

  render();
  setInterval(render, intervalSec * 1000);
}

// ---------- HELP ----------
else {
  console.log('Usage:');
  console.log('  node engine/evolution/monitor.js latest');
  console.log('  node engine/evolution/monitor.js trend [N]   (default N=20)');
  console.log('  node engine/evolution/monitor.js alerts');
  console.log('  node engine/evolution/monitor.js milestones');
  console.log('  node engine/evolution/monitor.js live [intervalSec] [points]  (default 5s, 20 pts)');
  process.exit(1);
}
