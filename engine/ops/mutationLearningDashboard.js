#!/usr/bin/env node
'use strict';

/**
 * Read-only ops dashboard for discovery/mutation_paper_learning.json.
 * Displays precomputed stats only — no learning / expectancy / multiplier recomputation.
 *
 * Output: ops-snapshot/mutation_learning_dashboard.html (+ console summary)
 *
 *   node engine/ops/mutationLearningDashboard.js
 *   MUTATION_LEARNING_DASHBOARD_OUT=/path/to.html node engine/ops/mutationLearningDashboard.js
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

const EPS = 0.0005; // yellow band near zero (display-only banding)

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readArtifact() {
  const root = dataRoot.getDataRoot();
  const p = path.join(root, 'discovery', 'mutation_paper_learning.json');
  if (!fs.existsSync(p)) {
    return { path: p, doc: null, error: 'file_missing' };
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const doc = JSON.parse(raw);
    return { path: p, doc, error: null };
  } catch (e) {
    return { path: p, doc: null, error: String(e && e.message ? e.message : e) };
  }
}

/** Expectancy row class — thresholds are presentation-only. */
function expectancyBand(exp) {
  const x = Number(exp);
  if (!Number.isFinite(x)) return 'neutral';
  if (x > 0) return 'green';
  if (x >= -EPS) return 'yellow';
  return 'red';
}

function expectancyLabel(exp) {
  const b = expectancyBand(exp);
  if (b === 'green') return '🟢';
  if (b === 'yellow') return '🟡';
  if (b === 'red') return '🔴';
  return '—';
}

/**
 * Consistency flags — compares precomputed expectancy vs precomputed multiplier only.
 */
function consistencyLabel(expectancy, multiplier) {
  const e = Number(expectancy);
  const m = Number(multiplier);
  if (!Number.isFinite(e) || !Number.isFinite(m)) return { code: '—', detail: 'missing number' };
  if (e < 0 && m > 1) return { code: 'OVERWEIGHTED BAD', detail: 'negative expectancy, multiplier > 1' };
  if (e > 0 && m < 1) return { code: 'UNDERUSED GOOD', detail: 'positive expectancy, multiplier < 1' };
  return { code: 'OK', detail: 'aligned' };
}

function buildRows(doc) {
  const entries = doc && doc.stats && Array.isArray(doc.stats.entries) ? doc.stats.entries : [];
  const agg = doc && doc.stats && doc.stats.agg && typeof doc.stats.agg === 'object' ? doc.stats.agg : {};
  const multipliers =
    doc && doc.multipliers && typeof doc.multipliers === 'object' ? doc.multipliers : {};

  const rows = entries.map((en) => {
    const mt = en && en.mt != null ? String(en.mt) : '';
    const n = Number(en.n);
    const expectancy = en.expectancy;
    const winRate = en.winRate;
    const a = agg[mt];
    const pnlSum = a && Number.isFinite(Number(a.pnlSum)) ? Number(a.pnlSum) : null;
    const mult = multipliers[mt];
    const multN = Number(mult);
    const multOk = Number.isFinite(multN);
    const cons = consistencyLabel(expectancy, multOk ? multN : NaN);
    return {
      mt,
      n: Number.isFinite(n) ? n : '—',
      winRate: Number.isFinite(Number(winRate)) ? Number(winRate) : null,
      expectancy: Number.isFinite(Number(expectancy)) ? Number(expectancy) : null,
      pnlSum,
      multiplier: multOk ? multN : null,
      band: expectancyBand(expectancy),
      signal: expectancyLabel(expectancy),
      consistency: cons.code,
      consistencyDetail: cons.detail,
    };
  });

  rows.sort((a, b) => {
    const ea = Number.isFinite(a.expectancy) ? a.expectancy : -Infinity;
    const eb = Number.isFinite(b.expectancy) ? b.expectancy : -Infinity;
    return eb - ea;
  });

  return rows;
}

function formatPct(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(1)}%`;
}

function formatNum(x, digits = 6) {
  if (x == null || !Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

function buildHtml({ path: artifactPath, doc, error }) {
  if (error === 'file_missing') {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Mutation paper learning</title></head><body><h1>Paper Learning Status</h1><p>No data available — artifact not found.</p><p><code>${escapeHtml(artifactPath)}</code></p></body></html>`;
  }
  if (error || !doc) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Mutation paper learning</title></head><body><h1>Paper Learning Status</h1><p>No data available — read error.</p><pre>${escapeHtml(error || 'unknown')}</pre></body></html>`;
  }

  const applied = doc.applied === true && doc.skipped === false;
  const tradeCount = Number(doc.tradeCount);
  const mapped = doc.stats && Number.isFinite(Number(doc.stats.mappedTrades)) ? Number(doc.stats.mappedTrades) : null;
  const genAt = doc.generatedAt != null ? String(doc.generatedAt) : '—';
  const cov =
    mapped != null && Number.isFinite(tradeCount) && tradeCount > 0
      ? ((100 * mapped) / tradeCount).toFixed(1)
      : '—';

  const rows = buildRows(doc);

  const tableRows =
    rows.length === 0
      ? '<tr><td colspan="8">No stats.entries in artifact (learning may be skipped or insufficient coverage).</td></tr>'
      : rows
          .map((r) => {
            const pnl = r.pnlSum != null ? formatNum(r.pnlSum, 4) : '—';
            const exp = r.expectancy != null ? formatNum(r.expectancy, 6) : '—';
            const wr = formatPct(r.winRate);
            const mul = r.multiplier != null ? String(r.multiplier) : '—';
            const cls = `row-${r.band}`;
            const consWarn = r.consistency === 'OVERWEIGHTED BAD' || r.consistency === 'UNDERUSED GOOD' ? ' ⚠️' : '';
            return `<tr class="${cls}">
  <td><code>${escapeHtml(r.mt)}</code></td>
  <td>${escapeHtml(String(r.n))}</td>
  <td>${escapeHtml(wr)}</td>
  <td>${escapeHtml(exp)}</td>
  <td>${escapeHtml(pnl)}</td>
  <td>${escapeHtml(mul)}</td>
  <td>${r.signal}${escapeHtml(consWarn)}</td>
  <td title="${escapeHtml(r.consistencyDetail)}">${escapeHtml(r.consistency)}</td>
</tr>`;
          })
          .join('\n');

  const insights = buildInsightsText(rows, applied);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Mutation paper learning — ops</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.25rem; color: #1a1a1a; max-width: 1200px; }
    h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .muted { color: #555; font-size: 0.9rem; }
    .ok { color: #0a7; }
    .bad { color: #c33; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; font-size: 0.9rem; }
    th, td { border: 1px solid #ccc; padding: 0.45rem 0.6rem; text-align: left; }
    th { background: #f4f4f4; }
    tr.row-green { background: #eefaee; }
    tr.row-yellow { background: #fffbeb; }
    tr.row-red { background: #fdeeee; }
    tr.row-neutral { background: #fafafa; }
    pre.insights { white-space: pre-wrap; background: #f8f8f8; padding: 0.75rem; border: 1px solid #ddd; margin-top: 1rem; font-size: 0.85rem; }
    code { font-size: 0.88em; }
  </style>
</head>
<body>
  <h1>Paper Learning Status</h1>
  <p class="muted">Source: <code>${escapeHtml(artifactPath)}</code> (read-only)</p>
  <p><strong>Applied:</strong> ${applied ? '<span class="ok">✅ yes</span>' : '<span class="bad">❌ no</span>'}</p>
  <p><strong>Mapped trades:</strong> ${mapped != null ? escapeHtml(String(mapped)) : '—'} / ${Number.isFinite(tradeCount) ? escapeHtml(String(tradeCount)) : '—'}</p>
  <p><strong>Coverage:</strong> ${escapeHtml(String(cov))}${cov !== '—' ? '%' : ''}</p>
  <p><strong>Last update:</strong> ${escapeHtml(genAt)}</p>
  ${doc.reason && !applied ? `<p class="bad"><strong>Reason:</strong> ${escapeHtml(String(doc.reason))}</p>` : ''}

  <h2 style="margin-top:1.5rem;font-size:1.05rem;">Mutation types (by expectancy ↓)</h2>
  <p class="muted">Expectancy band: 🟢 &gt; 0 · 🟡 [${-EPS}, 0] · 🔴 &lt; ${-EPS} (display only)</p>
  <table>
    <thead>
      <tr>
        <th>Mutation type</th>
        <th>Trades</th>
        <th>Win rate</th>
        <th>Expectancy</th>
        <th>PnL total</th>
        <th>Multiplier</th>
        <th>Signal</th>
        <th>Consistency</th>
      </tr>
    </thead>
    <tbody>
${tableRows}
    </tbody>
  </table>

  <h2 style="margin-top:1.5rem;font-size:1.05rem;">Insights</h2>
  <pre class="insights">${escapeHtml(insights)}</pre>
</body>
</html>`;
}

function buildInsightsText(rows, applied) {
  const lines = [];
  if (!applied) {
    lines.push('Learning not applied in this artifact — see Reason above.');
    return lines.join('\n');
  }
  if (!rows.length) {
    lines.push('No entry rows to summarize.');
    return lines.join('\n');
  }

  const finite = rows.filter((r) => r.expectancy != null && Number.isFinite(r.expectancy));
  if (finite.length) {
    const top = finite.reduce((a, b) => (a.expectancy >= b.expectancy ? a : b));
    const worst = finite.reduce((a, b) => (a.expectancy <= b.expectancy ? a : b));
    lines.push(`Top performer (expectancy): ${top.mt} (${formatNum(top.expectancy, 6)})`);
    lines.push(`Weakest performer (expectancy): ${worst.mt} (${formatNum(worst.expectancy, 6)})`);
  }

  const allNeg = finite.length > 0 && finite.every((r) => r.expectancy < 0);
  if (allNeg) lines.push('- All listed mutation types show negative expectancy in this snapshot.');

  const bad = rows.filter((r) => r.consistency === 'OVERWEIGHTED BAD');
  const under = rows.filter((r) => r.consistency === 'UNDERUSED GOOD');
  if (bad.length) {
    lines.push('- Inconsistencies (negative expectancy but multiplier > 1):');
    bad.forEach((r) =>
      lines.push(`  • ${r.mt}: multiplier=${r.multiplier != null ? r.multiplier : '—'}`)
    );
  } else {
    lines.push('- No "overweighted bad" cases (negative exp + mult > 1).');
  }
  if (under.length) {
    lines.push('- Note: positive expectancy but multiplier < 1 (underused good):');
    under.forEach((r) =>
      lines.push(`  • ${r.mt}: multiplier=${r.multiplier != null ? r.multiplier : '—'}`)
    );
  }

  lines.push('');
  lines.push('Thresholds above are for display only; learning math is unchanged.');
  return lines.join('\n');
}

function consoleSummary({ path: artifactPath, doc, error }, rows) {
  if (error === 'file_missing') {
    console.log('[mutation_learning_dashboard] No artifact:', artifactPath);
    return;
  }
  if (error || !doc) {
    console.log('[mutation_learning_dashboard] Read error:', error || 'unknown');
    return;
  }
  const applied = doc.applied === true && doc.skipped === false;
  const mapped = doc.stats && doc.stats.mappedTrades;
  const tc = doc.tradeCount;
  console.log('[mutation_learning_dashboard] artifact:', artifactPath);
  console.log('[mutation_learning_dashboard] applied:', applied, '| mapped:', mapped, '/ tradeCount:', tc);
  if (!rows.length) {
    console.log('[mutation_learning_dashboard] No table rows (skipped or missing entries).');
    return;
  }
  const finite = rows.filter((r) => r.expectancy != null && Number.isFinite(r.expectancy));
  if (finite.length) {
    const top = finite.reduce((a, b) => (a.expectancy >= b.expectancy ? a : b));
    const worst = finite.reduce((a, b) => (a.expectancy <= b.expectancy ? a : b));
    console.log(
      '[mutation_learning_dashboard] top performer (expectancy):',
      top.mt,
      '=',
      top.expectancy
    );
    console.log(
      '[mutation_learning_dashboard] weakest performer (expectancy):',
      worst.mt,
      '=',
      worst.expectancy
    );
  }
  const bad = rows.filter((r) => r.consistency === 'OVERWEIGHTED BAD');
  if (bad.length) {
    console.log(
      '[mutation_learning_dashboard] INCONSISTENT (neg exp, mult>1):',
      bad.map((r) => r.mt).join(', ')
    );
  } else {
    console.log('[mutation_learning_dashboard] No overweighted-bad inconsistencies.');
  }
}

function run() {
  const loaded = readArtifact();
  const rows = loaded.doc ? buildRows(loaded.doc) : [];
  const html = buildHtml(loaded);

  const repoRoot = path.resolve(__dirname, '../..');
  const outDefault = path.join(repoRoot, 'ops-snapshot', 'mutation_learning_dashboard.html');
  const outPath = process.env.MUTATION_LEARNING_DASHBOARD_OUT || outDefault;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');

  consoleSummary(loaded, rows);
  console.log('[mutation_learning_dashboard] wrote:', outPath);
}

if (require.main === module) {
  run();
}

module.exports = {
  readArtifact,
  buildRows,
  buildHtml,
  buildInsightsText,
  expectancyBand,
  consistencyLabel,
  run,
};
