#!/usr/bin/env node
'use strict';

/**
 * Read-only diagnostics from governance/paper_trades.jsonl (no learning / guard / live).
 * Writes HTML only under ops-snapshot/.
 *
 *   node engine/ops/paperLossDiagnostics.js
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const { parsePaperTradesJsonlContent } = require('../governance/parsePaperTradesJsonl');

const EXPECT_RED = -0.0005;
const INSIGHT_MIN_TRADES = 10;
const INSIGHT_NEG_EXP = -0.0005;

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** stop | target | timeout | other */
function reasonDim(reason) {
  const r = String(reason || '').trim().toLowerCase();
  if (r === 'stop' || r === 'stop_intrabar_priority') return 'stop';
  if (r === 'target') return 'target';
  if (r === 'time' || r === 'max_bars' || r === 'end_of_path') return 'timeout';
  return 'other';
}

function barsHeldBucket(barsHeld) {
  const n = Number(barsHeld);
  if (!Number.isFinite(n) || n < 1) return 'unknown';
  if (n === 1) return '1';
  if (n <= 3) return '2-3';
  if (n <= 6) return '4-6';
  return '7+';
}

function dimKey(val, missingLabel) {
  if (val == null) return missingLabel;
  const s = String(val).trim();
  return s ? s : missingLabel;
}

function emptyAgg() {
  return { trades: 0, wins: 0, pnlSum: 0 };
}

function add(agg, key, pnl) {
  if (!agg[key]) agg[key] = emptyAgg();
  const a = agg[key];
  a.trades += 1;
  const x = Number(pnl);
  if (Number.isFinite(x)) a.pnlSum += x;
  if (Number.isFinite(x) && x > 0) a.wins += 1;
}

function toRows(agg) {
  return Object.keys(agg).map((key) => {
    const a = agg[key];
    const n = a.trades;
    return {
      key,
      trades: n,
      wins: a.wins,
      pnlSum: a.pnlSum,
      expectancy: n > 0 ? a.pnlSum / n : 0,
      winRate: n > 0 ? a.wins / n : 0,
    };
  });
}

function sortWorst(rows) {
  return [...rows].sort((a, b) => a.expectancy - b.expectancy);
}

function band(exp) {
  if (!Number.isFinite(exp)) return 'neutral';
  if (exp < EXPECT_RED) return 'red';
  if (exp <= 0) return 'yellow';
  return 'green';
}

function emojiForBand(b) {
  if (b === 'red') return '🔴';
  if (b === 'yellow') return '🟡';
  if (b === 'green') return '🟢';
  return '—';
}

function formatConsoleRow(dimName, r) {
  return `${dimName}=${r.key} trades=${r.trades} expectancy=${r.expectancy.toFixed(6)} winRate=${r.winRate.toFixed(2)} pnl=${r.pnlSum.toFixed(4)}`;
}

function printSection(title, dimPrefix, rows) {
  console.log(title);
  for (const r of rows) {
    console.log(formatConsoleRow(dimPrefix, r));
  }
  console.log('');
}

function buildInsights(trades, bySymbol, byBars) {
  const lines = [];
  const n = trades.length;
  if (n === 0) return lines;

  let stops = 0;
  let bars1 = 0;
  for (const t of trades) {
    if (reasonDim(t.reason) === 'stop') stops += 1;
    if (Number(t.barsHeld) === 1) bars1 += 1;
  }
  const stopRate = stops / n;
  if (stopRate > 0.6) {
    lines.push(`High stop rate detected (${(stopRate * 100).toFixed(1)}% of trades exit via stop).`);
  }
  const share1 = bars1 / n;
  if (share1 > 0.5) {
    lines.push(`Most activity is very short: ${(share1 * 100).toFixed(1)}% of trades have barsHeld=1.`);
  }

  const symRows = sortWorst(toRows(bySymbol));
  const worstSym = symRows[0];
  if (
    worstSym &&
    worstSym.trades >= INSIGHT_MIN_TRADES &&
    worstSym.expectancy < INSIGHT_NEG_EXP
  ) {
    lines.push(
      `${worstSym.key} underperforming significantly (expectancy=${worstSym.expectancy.toFixed(6)}, trades=${worstSym.trades}).`
    );
  }

  const ctx = Object.create(null);
  for (const t of trades) {
    const sym = dimKey(t.symbol, '(missing)');
    const tf = dimKey(t.timeframe, '(missing)');
    const k = `${sym} ${tf}`;
    add(ctx, k, t.pnl);
  }
  const ctxRows = sortWorst(toRows(ctx)).filter((r) => r.trades >= INSIGHT_MIN_TRADES);
  const badCtx = ctxRows.filter((r) => r.expectancy < INSIGHT_NEG_EXP).slice(0, 3);
  for (const r of badCtx) {
    lines.push(`${r.key} underperforming significantly (expectancy=${r.expectancy.toFixed(6)}, trades=${r.trades}).`);
  }

  const barRows = sortWorst(toRows(byBars));
  const bar1 = barRows.find((r) => r.key === '1');
  if (bar1 && bar1.trades >= INSIGHT_MIN_TRADES && bar1.expectancy < INSIGHT_NEG_EXP) {
    lines.push(
      `Exits after 1 bar show weak expectancy (${bar1.expectancy.toFixed(6)} over ${bar1.trades} trades).`
    );
  }

  if (!lines.length) {
    lines.push('No automatic flags triggered (thresholds: stop_rate>60%, barsHeld=1 share>50%, expectancy<' + INSIGHT_NEG_EXP + ' with n≥' + INSIGHT_MIN_TRADES + ').');
  }
  return lines;
}

function htmlTableSection(title, rows, keyHeader) {
  const body = rows
    .map((r) => {
      const b = band(r.expectancy);
      const em = emojiForBand(b);
      return `<tr class="band-${b}">
  <td>${escapeHtml(em)} <code>${escapeHtml(r.key)}</code></td>
  <td>${r.trades}</td>
  <td>${r.wins}</td>
  <td>${escapeHtml(r.pnlSum.toFixed(4))}</td>
  <td>${escapeHtml(r.expectancy.toFixed(6))}</td>
  <td>${escapeHtml((r.winRate * 100).toFixed(1))}%</td>
</tr>`;
    })
    .join('\n');
  return `<h2>${escapeHtml(title)}</h2>
<table>
  <thead><tr><th>${escapeHtml(keyHeader)}</th><th>Trades</th><th>Wins</th><th>PnL sum</th><th>Expectancy</th><th>Win rate</th></tr></thead>
  <tbody>${body || '<tr><td colspan="6">No rows</td></tr>'}</tbody>
</table>`;
}

function buildHtml(totalTrades, jsonlPath, sections, insights) {
  const insightBlock =
    insights.length === 0
      ? '<p class="muted">No insights.</p>'
      : `<ul>${insights.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Paper loss diagnostics</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.25rem; color: #1a1a1a; max-width: 1100px; }
    h1 { font-size: 1.2rem; }
    h2 { font-size: 1.05rem; margin-top: 1.35rem; }
    .muted { color: #555; font-size: 0.9rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.4rem; font-size: 0.88rem; }
    th, td { border: 1px solid #ccc; padding: 0.4rem 0.55rem; text-align: left; }
    th { background: #f4f4f4; }
    tr.band-red { background: #fdeeee; }
    tr.band-yellow { background: #fffbeb; }
    tr.band-green { background: #eefaee; }
    tr.band-neutral { background: #fafafa; }
    code { font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>Paper loss diagnostics</h1>
  <p class="muted">Read-only · source: <code>${escapeHtml(jsonlPath)}</code></p>
  <p><strong>Total trades:</strong> ${totalTrades}</p>
  <p class="muted">Bands: 🔴 expectancy &lt; ${EXPECT_RED} · 🟡 [${EXPECT_RED}, 0] · 🟢 &gt; 0</p>
  ${sections}
  <h2>Insights</h2>
  ${insightBlock}
</body>
</html>`;
}

function run() {
  const root = dataRoot.getDataRoot();
  const jsonlPath = path.join(root, 'governance', 'paper_trades.jsonl');
  const repoRoot = path.resolve(__dirname, '../..');
  const outPath = path.join(repoRoot, 'ops-snapshot', 'paper_loss_diagnostics.html');

  if (!fs.existsSync(jsonlPath)) {
    console.log('No data available (file missing).');
    console.log('Expected:', jsonlPath);
    const html = buildHtml(0, jsonlPath, '<p class="muted">No data available.</p>', []);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
    console.log('Wrote:', outPath);
    return;
  }

  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch (e) {
    console.log('No data available (read error).');
    console.log(String(e && e.message ? e.message : e));
    const html = buildHtml(0, jsonlPath, '<p class="muted">No data available.</p>', []);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
    console.log('Wrote:', outPath);
    return;
  }

  const { trades } = parsePaperTradesJsonlContent(raw);
  if (!trades.length) {
    console.log('No data available (zero valid trades).');
    const html = buildHtml(0, jsonlPath, '<p class="muted">No data available.</p>', []);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
    console.log('Wrote:', outPath);
    return;
  }

  const MISSING = '(missing)';
  const bySymbol = Object.create(null);
  const byTf = Object.create(null);
  const byDir = Object.create(null);
  const byReason = Object.create(null);
  const byBars = Object.create(null);

  for (const t of trades) {
    const pnl = t.pnl;
    add(bySymbol, dimKey(t.symbol, MISSING), pnl);
    add(byTf, dimKey(t.timeframe, MISSING), pnl);
    const d =
      t.direction === 'long' || t.direction === 'short' ? t.direction : MISSING;
    add(byDir, d, pnl);
    add(byReason, reasonDim(t.reason), pnl);
    add(byBars, barsHeldBucket(t.barsHeld), pnl);
  }

  const symSorted = sortWorst(toRows(bySymbol));
  const tfSorted = sortWorst(toRows(byTf));
  const reasonSorted = sortWorst(toRows(byReason));
  const barsSorted = sortWorst(toRows(byBars));

  printSection('=== WORST BY SYMBOL ===', 'symbol', symSorted);
  printSection('=== WORST BY TIMEFRAME ===', 'timeframe', tfSorted);
  printSection('=== WORST BY REASON ===', 'reason', reasonSorted);
  printSection('=== WORST BY BARS HELD ===', 'bars', barsSorted);

  const insights = buildInsights(trades, bySymbol, byBars);
  console.log('=== INSIGHTS ===');
  for (const line of insights) console.log(line);
  console.log('');

  const sections =
    htmlTableSection('By symbol', symSorted, 'Symbol') +
    htmlTableSection('By timeframe', tfSorted, 'Timeframe') +
    htmlTableSection('By direction', sortWorst(toRows(byDir)), 'Direction') +
    htmlTableSection('By reason', reasonSorted, 'Reason') +
    htmlTableSection('By bars held', barsSorted, 'Bars held');

  const html = buildHtml(trades.length, jsonlPath, sections, insights);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('Wrote:', outPath);
}

if (require.main === module) {
  run();
}

module.exports = { run };
