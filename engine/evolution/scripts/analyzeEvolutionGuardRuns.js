#!/usr/bin/env node
'use strict';

/**
 * Analyze recent evolution_metrics.log NDJSON for evolutionGuard metrics.
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/evolution/scripts/analyzeEvolutionGuardRuns.js
 *   node engine/evolution/scripts/analyzeEvolutionGuardRuns.js --last 30
 *   node engine/evolution/scripts/analyzeEvolutionGuardRuns.js --file path/to/log --json
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG = path.join(__dirname, '..', 'logs', 'evolution_metrics.log');

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function mean(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function roundN(x, decimals) {
  if (x == null || !Number.isFinite(x)) return x;
  const p = 10 ** decimals;
  return Math.round(x * p) / p;
}

/**
 * @param {Array<[number, number]>} pairs both values finite
 * @returns {{ pearson: number|null, n: number, warning: string|null }}
 */
function pearsonCorrelation(pairs) {
  const n = pairs.length;
  if (n < 5) {
    return { pearson: null, n, warning: 'sample too small' };
  }
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const vx = xs[i] - mx;
    const vy = ys[i] - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  const den = Math.sqrt(dx * dy);
  if (den === 0) {
    return { pearson: 0, n, warning: null };
  }
  return { pearson: roundN(num / den, 4), n, warning: null };
}

function statBlock(values) {
  if (!values.length) {
    return { mean: null, median: null, min: null, max: null };
  }
  return {
    mean: roundN(mean(values), 4),
    median: roundN(median(values), 4),
    min: values.reduce((a, b) => Math.min(a, b)),
    max: values.reduce((a, b) => Math.max(a, b)),
  };
}

function parseArgs(argv) {
  let file = DEFAULT_LOG;
  let lastN = 50;
  let jsonOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' && argv[i + 1]) {
      file = path.resolve(String(argv[++i]));
    } else if (a === '--last' && argv[i + 1]) {
      const n = Math.max(1, Math.min(5000, Number(argv[++i]) || 50));
      lastN = n;
    } else if (a === '--json') {
      jsonOnly = true;
    }
  }
  return { file, lastN, jsonOnly };
}

function loadValidRows(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const msg = err && err.code === 'ENOENT' ? 'file not found' : 'unreadable';
    console.error(`analyzeEvolutionGuardRuns: ${msg}: ${filePath}`);
    process.exit(1);
  }

  const lines = raw.split('\n');
  const valid = [];
  let invalidRows = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      valid.push(JSON.parse(t));
    } catch (_) {
      invalidRows += 1;
    }
  }
  return { valid, invalidRows };
}

/**
 * @param {object[]} analyzedSlice last N valid rows
 */
function buildReport(filePath, analyzedSlice, invalidRows) {
  const rowsAnalyzed = analyzedSlice.length;

  const runsWithGuardField = analyzedSlice.filter(
    (r) => r && r.evolutionGuard != null && typeof r.evolutionGuard === 'object'
  ).length;

  const guardEnabledRows = analyzedSlice.filter(
    (r) => r && r.evolutionGuard && r.evolutionGuard.enabled === true
  );

  const runsWithGuardEnabled = guardEnabledRows.length;

  const runsWithAnySkip = guardEnabledRows.filter((r) => {
    const sk = safeNumber(r.evolutionGuard.skippedSetups);
    return sk != null && sk > 0;
  }).length;

  let pctRunsWithSkip = null;
  if (runsWithGuardEnabled > 0) {
    pctRunsWithSkip = roundN((runsWithAnySkip / runsWithGuardEnabled) * 100, 2);
  }

  const skippedVals = [];
  const unmappedVals = [];
  const filteredVals = [];
  for (const r of guardEnabledRows) {
    const g = r.evolutionGuard;
    const sk = safeNumber(g.skippedSetups);
    const um = safeNumber(g.unmappedSetups);
    const fp = safeNumber(g.filteredPct);
    if (sk != null && sk >= 0) skippedVals.push(sk);
    if (um != null && um >= 0) unmappedVals.push(um);
    if (fp != null) filteredVals.push(fp);
  }

  const metrics = {
    skippedSetups: statBlock(skippedVals),
    unmappedSetups: statBlock(unmappedVals),
    filteredPct: statBlock(filteredVals),
  };

  function pairsFor(fnX, fnY) {
    const out = [];
    for (const r of guardEnabledRows) {
      const g = r.evolutionGuard;
      const x = fnX(r, g);
      const y = fnY(r, g);
      if (x != null && y != null) out.push([x, y]);
    }
    return out;
  }

  const corrSkippedWildcard = pearsonCorrelation(
    pairsFor(
      (_, g) => safeNumber(g.skippedSetups),
      (r) => safeNumber(r.wildcardPromotions)
    )
  );
  const corrSkippedDelta = pearsonCorrelation(
    pairsFor(
      (_, g) => safeNumber(g.skippedSetups),
      (r) => safeNumber(r.delta)
    )
  );
  const corrFpWildcard = pearsonCorrelation(
    pairsFor(
      (_, g) => safeNumber(g.filteredPct),
      (r) => safeNumber(r.wildcardPromotions)
    )
  );
  const corrFpDelta = pearsonCorrelation(
    pairsFor(
      (_, g) => safeNumber(g.filteredPct),
      (r) => safeNumber(r.delta)
    )
  );

  const corrShape = (c) => ({
    n: c.n,
    pearson: c.pearson,
    warning: c.warning,
  });

  const skipRuns = guardEnabledRows.filter((r) => {
    const sk = safeNumber(r.evolutionGuard.skippedSetups);
    return sk != null && sk > 0;
  });
  const noSkipRuns = guardEnabledRows.filter((r) => {
    const sk = safeNumber(r.evolutionGuard.skippedSetups);
    return sk != null && sk === 0;
  });

  function groupAvg(rows, key) {
    const vals = rows.map((r) => safeNumber(r[key])).filter((v) => v != null);
    return vals.length ? roundN(mean(vals), 6) : null;
  }

  function groupedBlock(rows) {
    return {
      count: rows.length,
      avgDelta: groupAvg(rows, 'delta'),
      avgWildcardPromotions: groupAvg(rows, 'wildcardPromotions'),
      avgChampions: groupAvg(rows, 'champions'),
      avgValidated: groupAvg(rows, 'validated'),
    };
  }

  const grouped = {
    skipRuns: groupedBlock(skipRuns),
    noSkipRuns: groupedBlock(noSkipRuns),
  };

  return {
    file: filePath,
    rowsAnalyzed,
    invalidRows,
    runsWithGuardField,
    runsWithGuardEnabled,
    runsWithAnySkip,
    pctRunsWithSkip,
    metrics,
    correlations: {
      skipped_vs_wildcardPromotions: corrShape(corrSkippedWildcard),
      skipped_vs_delta: corrShape(corrSkippedDelta),
      filteredPct_vs_wildcardPromotions: corrShape(corrFpWildcard),
      filteredPct_vs_delta: corrShape(corrFpDelta),
    },
    grouped,
  };
}

function printHumanSummary(rep) {
  const lines = [];
  lines.push(
    `analyzed ${rep.rowsAnalyzed} valid rows (${rep.invalidRows} invalid skipped)`
  );
  lines.push(
    `evolutionGuard field present in ${rep.runsWithGuardField}/${rep.rowsAnalyzed} runs`
  );
  lines.push(
    `evolutionGuard enabled in ${rep.runsWithGuardEnabled}/${rep.rowsAnalyzed} runs`
  );
  if (rep.runsWithGuardEnabled > 0) {
    const pct =
      rep.pctRunsWithSkip != null
        ? `${rep.pctRunsWithSkip}%`
        : 'n/a';
    lines.push(
      `skips occurred in ${rep.runsWithAnySkip}/${rep.runsWithGuardEnabled} enabled runs (${pct})`
    );
  } else {
    lines.push('no guard-enabled runs in window — skip % n/a');
  }

  const m = rep.metrics;
  const fmt = (block, label) => {
    if (block.mean == null) {
      lines.push(`${label} mean/median: n/a (no data)`);
    } else {
      lines.push(
        `${label} mean/median: ${block.mean} / ${block.median} (min ${block.min}, max ${block.max})`
      );
    }
  };
  fmt(m.skippedSetups, 'skippedSetups');
  fmt(m.unmappedSetups, 'unmappedSetups');
  fmt(m.filteredPct, 'filteredPct');

  const c = rep.correlations;
  const corrLine = (name, obj) => {
    if (obj.warning) {
      lines.push(`corr(${name}): n=${obj.n} — ${obj.warning}`);
    } else {
      lines.push(`corr(${name}): ${obj.pearson} (n=${obj.n})`);
    }
  };
  corrLine('skipped vs wildcardPromotions', c.skipped_vs_wildcardPromotions);
  corrLine('skipped vs delta', c.skipped_vs_delta);
  corrLine('filteredPct vs wildcardPromotions', c.filteredPct_vs_wildcardPromotions);
  corrLine('filteredPct vs delta', c.filteredPct_vs_delta);

  console.log(lines.join('\n'));
}

function main() {
  const { file, lastN, jsonOnly } = parseArgs(process.argv.slice(2));
  const { valid, invalidRows } = loadValidRows(file);
  const analyzedSlice = valid.slice(-lastN);
  const rep = buildReport(file, analyzedSlice, invalidRows);

  if (!jsonOnly) {
    printHumanSummary(rep);
    console.log('');
  }
  console.log(JSON.stringify(rep, null, 2));
}

module.exports = {
  safeNumber,
  mean,
  median,
  pearsonCorrelation,
  parseArgs,
  loadValidRows,
  buildReport,
};

if (require.main === module) {
  main();
}
