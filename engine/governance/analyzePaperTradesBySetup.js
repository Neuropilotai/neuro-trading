#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const { parsePaperTradesJsonlContent } = require('./parsePaperTradesJsonl');

const WINDOWS = Object.freeze([
  { id: 'all_time', days: null },
  { id: 'last_7d', days: 7 },
  { id: 'last_3d', days: 3 },
  { id: 'last_1d', days: 1 },
]);

const DEFAULT_FOCUS_SETUPS = Object.freeze([
  'mut_151772_open_28bfd4',
  'mut_b7f56c_mid_74a537',
  'mut_548a56_open_a14dba',
]);

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return null;
  const m = 10 ** digits;
  return Math.round(Number(value) * m) / m;
}

function parseIsoMs(value) {
  if (value == null || value === '') return null;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toIsoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeId(value) {
  if (value == null) return '';
  return String(value).trim();
}

function setupKeyFromParts(setupId, strategyId) {
  const s = normalizeId(setupId);
  if (s) return s;
  const g = normalizeId(strategyId);
  return g || '';
}

function csvEscape(value) {
  const raw = value == null ? '' : String(value);
  if (raw.includes('"') || raw.includes(',') || raw.includes('\n')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function computeMetrics(rows) {
  const trades = Array.isArray(rows) ? rows : [];
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalPnl = 0;
  let grossProfit = 0;
  let grossLossAbs = 0;
  let firstTradeMs = null;
  let lastTradeMs = null;
  const cyclesSeen = new Set();
  const reasons = {};

  for (const t of trades) {
    const pnl = safeNum(t.pnl, NaN);
    if (!Number.isFinite(pnl)) continue;
    totalPnl += pnl;
    if (pnl > 0) {
      wins += 1;
      grossProfit += pnl;
    } else if (pnl < 0) {
      losses += 1;
      grossLossAbs += Math.abs(pnl);
    } else {
      breakeven += 1;
    }

    const tsMs = parseIsoMs(t.marketTs);
    if (tsMs != null) {
      if (firstTradeMs == null || tsMs < firstTradeMs) firstTradeMs = tsMs;
      if (lastTradeMs == null || tsMs > lastTradeMs) lastTradeMs = tsMs;
    }

    const cycleId = normalizeId(t.cycleId);
    if (cycleId) cyclesSeen.add(cycleId);
    const reason = normalizeId(t.reason);
    if (reason) reasons[reason] = (reasons[reason] || 0) + 1;
  }

  const tradeCount = wins + losses + breakeven;
  const winRate = tradeCount > 0 ? (wins / tradeCount) * 100 : null;
  const avgPnl = tradeCount > 0 ? totalPnl / tradeCount : null;
  let profitFactor = null;
  if (grossLossAbs > 0) profitFactor = grossProfit / grossLossAbs;

  return {
    totalTrades: tradeCount,
    wins,
    losses,
    breakeven,
    winRate: round(winRate, 4),
    totalPnl: round(totalPnl, 8),
    avgPnl: round(avgPnl, 8),
    grossProfit: round(grossProfit, 8),
    grossLossAbs: round(grossLossAbs, 8),
    profitFactor: round(profitFactor, 8),
    firstTradeTs: toIsoOrNull(firstTradeMs),
    lastTradeTs: toIsoOrNull(lastTradeMs),
    cyclesSeen: Array.from(cyclesSeen).sort(),
    reasons,
  };
}

function computeMedian(numbers) {
  const arr = (Array.isArray(numbers) ? numbers : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  if (!arr.length) return null;
  const m = Math.floor(arr.length / 2);
  return arr.length % 2 === 1 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}

function groupComparison(rows, isPromotedGroup) {
  const setups = rows.filter((r) => r.isPromoted === isPromotedGroup);
  const setupCount = setups.length;
  const totalTrades = setups.reduce((acc, x) => acc + safeNum(x.metrics.totalTrades, 0), 0);
  const totalPnl = setups.reduce((acc, x) => acc + safeNum(x.metrics.totalPnl, 0), 0);
  const grossProfit = setups.reduce((acc, x) => acc + safeNum(x.metrics.grossProfit, 0), 0);
  const grossLossAbs = setups.reduce((acc, x) => acc + safeNum(x.metrics.grossLossAbs, 0), 0);
  const pfAggregate = grossLossAbs > 0 ? grossProfit / grossLossAbs : null;
  const avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : null;
  const medianTotalPnlPerSetup = computeMedian(setups.map((x) => x.metrics.totalPnl));
  const avgProfitFactorPerSetup = computeMedian(setups.map((x) => x.metrics.profitFactor));
  return {
    setupCount,
    totalTrades,
    totalPnl: round(totalPnl, 8),
    avgPnlPerTrade: round(avgPnlPerTrade, 8),
    medianTotalPnlPerSetup: round(medianTotalPnlPerSetup, 8),
    aggregateProfitFactor: round(pfAggregate, 8),
    medianProfitFactorPerSetup: round(avgProfitFactorPerSetup, 8),
  };
}

function topBottomByPnl(rows, n) {
  const list = rows.slice().sort((a, b) => safeNum(b.metrics.totalPnl, 0) - safeNum(a.metrics.totalPnl, 0));
  return {
    top: list.slice(0, n).map((x) => ({ setupKey: x.setupKey, isPromoted: x.isPromoted, ...x.metrics })),
    bottom: list.slice(-n).reverse().map((x) => ({ setupKey: x.setupKey, isPromoted: x.isPromoted, ...x.metrics })),
  };
}

function topBottomByPf(rows, n, minTrades) {
  const eligible = rows.filter((x) => safeNum(x.metrics.totalTrades, 0) >= minTrades && x.metrics.profitFactor != null);
  const sorted = eligible.slice().sort((a, b) => safeNum(b.metrics.profitFactor, -1) - safeNum(a.metrics.profitFactor, -1));
  return {
    minTrades,
    top: sorted.slice(0, n).map((x) => ({ setupKey: x.setupKey, isPromoted: x.isPromoted, ...x.metrics })),
    bottom: sorted.slice(-n).reverse().map((x) => ({ setupKey: x.setupKey, isPromoted: x.isPromoted, ...x.metrics })),
  };
}

function concentration(rows) {
  const sortedByPnlAsc = rows.slice().sort((a, b) => safeNum(a.metrics.totalPnl, 0) - safeNum(b.metrics.totalPnl, 0));
  const sortedByPnlDesc = rows.slice().sort((a, b) => safeNum(b.metrics.totalPnl, 0) - safeNum(a.metrics.totalPnl, 0));
  const worst5 = sortedByPnlAsc.slice(0, 5);
  const best5 = sortedByPnlDesc.slice(0, 5);
  const negativeTotal = rows.reduce((acc, x) => {
    const p = safeNum(x.metrics.totalPnl, 0);
    return p < 0 ? acc + Math.abs(p) : acc;
  }, 0);
  const positiveTotal = rows.reduce((acc, x) => {
    const p = safeNum(x.metrics.totalPnl, 0);
    return p > 0 ? acc + p : acc;
  }, 0);
  const worst5Abs = worst5.reduce((acc, x) => {
    const p = safeNum(x.metrics.totalPnl, 0);
    return p < 0 ? acc + Math.abs(p) : acc;
  }, 0);
  const best5Pos = best5.reduce((acc, x) => {
    const p = safeNum(x.metrics.totalPnl, 0);
    return p > 0 ? acc + p : acc;
  }, 0);
  return {
    negativePnl: round(-negativeTotal, 8),
    positivePnl: round(positiveTotal, 8),
    worst5ExplainedSharePct: round(negativeTotal > 0 ? (worst5Abs / negativeTotal) * 100 : null, 4),
    best5ExplainedSharePct: round(positiveTotal > 0 ? (best5Pos / positiveTotal) * 100 : null, 4),
    worst5: worst5.map((x) => ({ setupKey: x.setupKey, totalPnl: x.metrics.totalPnl, totalTrades: x.metrics.totalTrades })),
    best5: best5.map((x) => ({ setupKey: x.setupKey, totalPnl: x.metrics.totalPnl, totalTrades: x.metrics.totalTrades })),
  };
}

function inferWindowRows(baseRows, window, anchorMs) {
  if (window.days == null) return baseRows.slice();
  const cutoff = anchorMs - window.days * 24 * 60 * 60 * 1000;
  return baseRows.filter((x) => x.marketTsMs != null && x.marketTsMs >= cutoff);
}

/** Parallel to inferWindowRows: rolling window on wall-clock simulatedAt (observability only). */
function inferSimulatedWindowRows(baseRows, window, anchorMs) {
  if (window.days == null) return baseRows.slice();
  const cutoff = anchorMs - window.days * 24 * 60 * 60 * 1000;
  return baseRows.filter((x) => x.simulatedAtMs != null && x.simulatedAtMs >= cutoff);
}

function loadJsonOptional(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function discoverFocusFromLatest(latestJson) {
  const out = new Set();
  if (!latestJson || typeof latestJson !== 'object') return out;
  const add = (v) => {
    const id = normalizeId(v);
    if (id) out.add(id);
  };
  const arrays = [
    latestJson.strategyTopPromotable,
    latestJson.strategyTopWatchlist,
    latestJson.strategyTransitionCandidates,
    latestJson.learningInsights && latestJson.learningInsights.topStrategies,
  ];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      if (!row || typeof row !== 'object') continue;
      add(row.strategyId);
      add(row.setupId);
    }
  }
  return out;
}

function parseArgs(argv) {
  const args = {
    minPfTrades: 10,
    topN: 10,
    focusSetups: [],
    outJson: null,
    outCsv: null,
    outStrictJson: null,
    includeOpsLatest: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-pf-trades' && argv[i + 1]) args.minPfTrades = Math.max(1, Math.floor(Number(argv[++i]) || 10));
    else if (a === '--top-n' && argv[i + 1]) args.topN = Math.max(1, Math.floor(Number(argv[++i]) || 10));
    else if (a === '--focus' && argv[i + 1]) {
      args.focusSetups = String(argv[++i]).split(',').map((x) => x.trim()).filter(Boolean);
    } else if (a === '--out-json' && argv[i + 1]) args.outJson = String(argv[++i]);
    else if (a === '--out-csv' && argv[i + 1]) args.outCsv = String(argv[++i]);
    else if (a === '--out-strict-json' && argv[i + 1]) args.outStrictJson = String(argv[++i]);
    else if (a === '--no-ops-latest') args.includeOpsLatest = false;
  }
  return args;
}

function buildCsv(rowsBySetup) {
  const headers = [
    'setupKey',
    'strategyIds',
    'setupIds',
    'isPromoted',
    'all_time_trades',
    'all_time_winRate',
    'all_time_totalPnl',
    'all_time_avgPnl',
    'all_time_profitFactor',
    'all_time_firstTradeTs',
    'all_time_lastTradeTs',
    'last_7d_trades',
    'last_7d_totalPnl',
    'last_7d_profitFactor',
    'last_3d_trades',
    'last_3d_totalPnl',
    'last_3d_profitFactor',
    'last_1d_trades',
    'last_1d_totalPnl',
    'last_1d_profitFactor',
  ];
  const lines = [headers.join(',')];
  for (const row of rowsBySetup) {
    const all = row.windows.all_time || {};
    const w7 = row.windows.last_7d || {};
    const w3 = row.windows.last_3d || {};
    const w1 = row.windows.last_1d || {};
    const values = [
      row.setupKey,
      (row.strategyIds || []).join('|'),
      (row.setupIds || []).join('|'),
      row.isPromoted ? 'true' : 'false',
      all.totalTrades,
      all.winRate,
      all.totalPnl,
      all.avgPnl,
      all.profitFactor,
      all.firstTradeTs,
      all.lastTradeTs,
      w7.totalTrades,
      w7.totalPnl,
      w7.profitFactor,
      w3.totalTrades,
      w3.totalPnl,
      w3.profitFactor,
      w1.totalTrades,
      w1.totalPnl,
      w1.profitFactor,
    ];
    lines.push(values.map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function compactMappingRow(row) {
  const w7 = row && row.windows && row.windows.last_7d ? row.windows.last_7d : {};
  return {
    setupKey: row.setupKey,
    setupId: Array.isArray(row.setupIds) && row.setupIds.length > 0 ? row.setupIds[0] : null,
    strategyId: Array.isArray(row.strategyIds) && row.strategyIds.length > 0 ? row.strategyIds[0] : null,
    isPromoted: row.isPromoted === true,
    tradesRecent: safeNum(w7.totalTrades, 0),
    pnlRecent: safeNum(w7.totalPnl, 0),
    lastTradeTs: w7.lastTradeTs || null,
  };
}

function keyPrefix(key) {
  const k = normalizeId(key).toLowerCase();
  if (k.startsWith('mut_')) return 'mut_';
  if (k.startsWith('familyexp_')) return 'familyexp_';
  if (k.startsWith('example_')) return 'example_';
  return 'other';
}

function fingerprint(key) {
  const k = normalizeId(key).toLowerCase();
  return k.replace(/[^a-z0-9]/g, '');
}

function hasPlausibleMatch(promotedKey, candidatePaperKeys) {
  const p = normalizeId(promotedKey).toLowerCase();
  const fp = fingerprint(promotedKey);
  for (const c of candidatePaperKeys) {
    const cl = normalizeId(c).toLowerCase();
    if (!cl) continue;
    if (p.includes(cl) || cl.includes(p)) return { match: c, reason: 'substring' };
    const cf = fingerprint(c);
    if (fp && cf && (fp.includes(cf) || cf.includes(fp))) return { match: c, reason: 'fingerprint_substring' };
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv);
  const root = dataRoot.getDataRoot();
  const promotedPath = path.join(root, 'discovery', 'promoted_children.json');
  const paperPath = path.join(root, 'governance', 'paper_trades.jsonl');
  const govDir = path.join(root, 'governance');
  const outJsonPath = args.outJson ? path.resolve(args.outJson) : path.join(govDir, 'paper_trades_by_setup_analysis.json');
  const outCsvPath = args.outCsv ? path.resolve(args.outCsv) : path.join(govDir, 'paper_trades_by_setup_analysis.csv');
  const outStrictJsonPath = args.outStrictJson
    ? path.resolve(args.outStrictJson)
    : path.join(govDir, 'paper_trades_strict_mapping_report.json');

  const promotedJson = loadJsonOptional(promotedPath);
  const promotedRows = Array.isArray(promotedJson && promotedJson.strategies) ? promotedJson.strategies : [];
  const promotedSetupIds = new Set();
  const promotedStrategyIds = new Set();
  const promotedJoinKeys = new Set();
  for (const r of promotedRows) {
    const setupId = normalizeId(r && r.setupId);
    const strategyId = normalizeId(r && r.strategyId);
    const key = setupKeyFromParts(setupId, strategyId);
    if (setupId) promotedSetupIds.add(setupId);
    if (strategyId) promotedStrategyIds.add(strategyId);
    if (key) promotedJoinKeys.add(key);
  }
  const promotedCatalog = promotedRows.map((r) => {
    const setupId = normalizeId(r && r.setupId);
    const strategyId = normalizeId(r && r.strategyId);
    return {
      setupKey: setupKeyFromParts(setupId, strategyId),
      setupId: setupId || null,
      strategyId: strategyId || null,
      isPromoted: true,
    };
  }).filter((x) => x.setupKey);

  const paperContent = fs.existsSync(paperPath) ? fs.readFileSync(paperPath, 'utf8') : '';
  const { trades, parseErrors, lineCount } = parsePaperTradesJsonlContent(paperContent);
  const normalizedTrades = trades
    .map((t) => {
      const setupId = normalizeId(t.setupId);
      const strategyId = normalizeId(t.strategyId);
      const setupKey = setupKeyFromParts(setupId, strategyId);
      const marketTs = normalizeId(t.exitTs) || normalizeId(t.ts);
      const marketTsMs = parseIsoMs(marketTs);
      const simulatedAt = normalizeId(t.simulatedAt);
      const simulatedAtMs = parseIsoMs(simulatedAt);
      if (!setupKey || marketTsMs == null) return null;
      return {
        setupKey,
        setupId,
        strategyId,
        marketTs,
        marketTsMs,
        simulatedAt,
        simulatedAtMs,
        cycleId: normalizeId(t.cycleId),
        reason: normalizeId(t.reason),
        pnl: t.pnl,
      };
    })
    .filter(Boolean);

  const anchorMs = normalizedTrades.reduce((acc, x) => (x.marketTsMs > acc ? x.marketTsMs : acc), 0);
  const simulatedAnchorMs = normalizedTrades.reduce(
    (acc, x) => (x.simulatedAtMs != null && x.simulatedAtMs > acc ? x.simulatedAtMs : acc),
    0
  );
  const allSetupKeys = new Set(normalizedTrades.map((x) => x.setupKey));
  const promotedInPaperBySetup = new Set(Array.from(allSetupKeys).filter((k) => promotedSetupIds.has(k) || promotedJoinKeys.has(k)));
  const promotedInPaperByStrategy = new Set(
    normalizedTrades.filter((x) => x.strategyId && promotedStrategyIds.has(x.strategyId)).map((x) => x.setupKey)
  );
  const overlappedSetupKeys = new Set([...promotedInPaperBySetup, ...promotedInPaperByStrategy]);

  const rowsBySetup = [];
  for (const setupKey of Array.from(allSetupKeys).sort()) {
    const setupTrades = normalizedTrades.filter((x) => x.setupKey === setupKey);
    const strategyIds = Array.from(new Set(setupTrades.map((x) => x.strategyId).filter(Boolean))).sort();
    const setupIds = Array.from(new Set(setupTrades.map((x) => x.setupId).filter(Boolean))).sort();
    const isPromoted =
      setupIds.some((x) => promotedSetupIds.has(x)) ||
      strategyIds.some((x) => promotedStrategyIds.has(x)) ||
      promotedJoinKeys.has(setupKey);

    const windows = {};
    for (const w of WINDOWS) {
      const windowTrades = inferWindowRows(setupTrades, w, anchorMs);
      windows[w.id] = computeMetrics(windowTrades);
    }
    rowsBySetup.push({
      setupKey,
      strategyIds,
      setupIds,
      isPromoted,
      windows,
    });
  }

  const rowByKey = new Map(rowsBySetup.map((r) => [r.setupKey, r]));
  const promotedOnly = promotedCatalog
    .filter((p) => !rowByKey.has(p.setupKey))
    .map((p) => ({
      setupKey: p.setupKey,
      setupId: p.setupId,
      strategyId: p.strategyId,
      isPromoted: true,
      tradesRecent: 0,
      pnlRecent: 0,
      lastTradeTs: null,
    }));
  const paperOnlyRecent = rowsBySetup
    .filter((r) => r.isPromoted !== true && safeNum(r.windows.last_7d.totalTrades, 0) > 0)
    .map(compactMappingRow);
  const promotedAndPaperRecent = rowsBySetup
    .filter((r) => r.isPromoted === true && safeNum(r.windows.last_7d.totalTrades, 0) > 0)
    .map(compactMappingRow);

  const simulatedRecentRows =
    simulatedAnchorMs > 0
      ? inferSimulatedWindowRows(normalizedTrades, { days: 7 }, simulatedAnchorMs)
      : [];
  const simulatedRecentSetupKeys = new Set(simulatedRecentRows.map((x) => x.setupKey));
  const promotedAndPaperRecentBySimulatedAt = rowsBySetup
    .filter((r) => r.isPromoted === true && simulatedRecentSetupKeys.has(r.setupKey))
    .map(compactMappingRow);

  const paperRecentNotPromotedButProfitable = rowsBySetup
    .filter(
      (r) =>
        r.isPromoted !== true &&
        safeNum(r.windows.last_7d.totalTrades, 0) > 0 &&
        safeNum(r.windows.last_7d.totalPnl, 0) > 0
    )
    .map(compactMappingRow)
    .sort((a, b) => safeNum(b.pnlRecent, 0) - safeNum(a.pnlRecent, 0));
  const promotedNotSeenInPaperLast7d = promotedCatalog
    .filter((p) => {
      const row = rowByKey.get(p.setupKey);
      return !row || safeNum(row.windows.last_7d.totalTrades, 0) === 0;
    })
    .map((p) => {
      const row = rowByKey.get(p.setupKey);
      if (!row) {
        return {
          setupKey: p.setupKey,
          setupId: p.setupId,
          strategyId: p.strategyId,
          isPromoted: true,
          tradesRecent: 0,
          pnlRecent: 0,
          lastTradeTs: null,
        };
      }
      return compactMappingRow(row);
    });

  const paperSetupIdsAll = new Set(normalizedTrades.map((t) => t.setupId).filter(Boolean));
  const paperStrategyIdsAll = new Set(normalizedTrades.map((t) => t.strategyId).filter(Boolean));
  const paperRecentRows = rowsBySetup.filter((r) => safeNum(r.windows.last_7d.totalTrades, 0) > 0);
  const paperRecentKeys = new Set(paperRecentRows.map((r) => r.setupKey));
  const paperRecentSetupIds = new Set(
    paperRecentRows.flatMap((r) => (Array.isArray(r.setupIds) ? r.setupIds : [])).filter(Boolean)
  );
  const paperRecentStrategyIds = new Set(
    paperRecentRows.flatMap((r) => (Array.isArray(r.strategyIds) ? r.strategyIds : [])).filter(Boolean)
  );

  const exactSetupKeyMatchAll = promotedCatalog.filter((p) => allSetupKeys.has(p.setupKey));
  const exactSetupKeyMatchRecent = promotedCatalog.filter((p) => paperRecentKeys.has(p.setupKey));
  const setupIdOnlyMatchAll = promotedCatalog.filter(
    (p) => p.setupId && paperSetupIdsAll.has(p.setupId) && !allSetupKeys.has(p.setupKey)
  );
  const strategyIdOnlyMatchAll = promotedCatalog.filter(
    (p) => p.strategyId && paperStrategyIdsAll.has(p.strategyId) && !allSetupKeys.has(p.setupKey)
  );
  const promotedSetupIdMatchesPaperStrategyIdAll = promotedCatalog.filter(
    (p) => p.setupId && paperStrategyIdsAll.has(p.setupId)
  );
  const promotedStrategyIdMatchesPaperSetupIdAll = promotedCatalog.filter(
    (p) => p.strategyId && paperSetupIdsAll.has(p.strategyId)
  );
  const promotedSetupIdMatchesPaperStrategyIdRecent = promotedCatalog.filter(
    (p) => p.setupId && paperRecentStrategyIds.has(p.setupId)
  );
  const promotedStrategyIdMatchesPaperSetupIdRecent = promotedCatalog.filter(
    (p) => p.strategyId && paperRecentSetupIds.has(p.strategyId)
  );

  const likelySameButMismatched = [];
  const noPlausibleMatch = [];
  const recentKeyList = Array.from(paperRecentKeys);
  for (const p of promotedNotSeenInPaperLast7d) {
    const plausible = hasPlausibleMatch(p.setupKey, recentKeyList);
    if (plausible) {
      likelySameButMismatched.push({
        promotedSetupKey: p.setupKey,
        candidatePaperSetupKey: plausible.match,
        reason: plausible.reason,
      });
    } else {
      noPlausibleMatch.push({
        promotedSetupKey: p.setupKey,
      });
    }
  }

  const prefixCounts = {
    promoted_all: { mut_: 0, familyexp_: 0, example_: 0, other: 0 },
    paper_all: { mut_: 0, familyexp_: 0, example_: 0, other: 0 },
    paper_recent: { mut_: 0, familyexp_: 0, example_: 0, other: 0 },
    overlap_recent: { mut_: 0, familyexp_: 0, example_: 0, other: 0 },
  };
  for (const p of promotedCatalog) prefixCounts.promoted_all[keyPrefix(p.setupKey)] += 1;
  for (const p of rowsBySetup) prefixCounts.paper_all[keyPrefix(p.setupKey)] += 1;
  for (const p of paperRecentRows) prefixCounts.paper_recent[keyPrefix(p.setupKey)] += 1;
  for (const p of promotedAndPaperRecent) prefixCounts.overlap_recent[keyPrefix(p.setupKey)] += 1;

  const windowComparisons = {};
  for (const w of WINDOWS) {
    const enrichedRows = rowsBySetup.map((r) => ({
      setupKey: r.setupKey,
      isPromoted: r.isPromoted,
      metrics: r.windows[w.id],
    })).filter((x) => safeNum(x.metrics.totalTrades, 0) > 0);

    windowComparisons[w.id] = {
      promoted: groupComparison(enrichedRows, true),
      nonPromoted: groupComparison(enrichedRows, false),
      topBottomByPnl: topBottomByPnl(enrichedRows, args.topN),
      topBottomByProfitFactor: topBottomByPf(enrichedRows, args.topN, args.minPfTrades),
      concentration: concentration(enrichedRows),
      activeSetups: enrichedRows.length,
      activePromotedSetups: enrichedRows.filter((x) => x.isPromoted).length,
      activeNonPromotedSetups: enrichedRows.filter((x) => !x.isPromoted).length,
    };
  }

  const allTimeCutoffMs = anchorMs - 7 * 24 * 60 * 60 * 1000;
  const recentUniqueSetups7d = new Set(normalizedTrades.filter((x) => x.marketTsMs >= allTimeCutoffMs).map((x) => x.setupKey));
  const newSetupsIn7d = new Set(
    rowsBySetup
      .filter((r) => {
        const first = parseIsoMs(r.windows.all_time.firstTradeTs);
        return first != null && first >= allTimeCutoffMs;
      })
      .map((r) => r.setupKey)
  );

  const repoOpsLatest = path.join(path.resolve(__dirname, '..', '..'), 'ops-snapshot', 'latest.json');
  const dataRootOpsLatest = path.join(root, 'ops-snapshot', 'latest.json');
  const opsLatest = args.includeOpsLatest
    ? (loadJsonOptional(repoOpsLatest) || loadJsonOptional(dataRootOpsLatest))
    : null;
  const dynamicFocus = discoverFocusFromLatest(opsLatest);
  const focusSetups = new Set([...DEFAULT_FOCUS_SETUPS, ...args.focusSetups, ...Array.from(dynamicFocus)]);

  const focusCheck = {};
  for (const id of Array.from(focusSetups).sort()) {
    const match = rowsBySetup.find((r) => r.setupKey === id || r.strategyIds.includes(id) || r.setupIds.includes(id));
    focusCheck[id] = {
      foundInPromotedChildren: promotedJoinKeys.has(id) || promotedSetupIds.has(id) || promotedStrategyIds.has(id),
      foundInPaper: Boolean(match),
      setupKey: match ? match.setupKey : null,
      isPromotedInJoin: match ? match.isPromoted : false,
      windows: match ? match.windows : null,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    dataRoot: root,
    artifacts: {
      promotedChildrenPath: promotedPath,
      paperTradesPath: paperPath,
      opsSnapshotLatestPath: opsLatest ? (fs.existsSync(repoOpsLatest) ? repoOpsLatest : dataRootOpsLatest) : null,
    },
    structureAudit: {
      promotedChildren: {
        topLevelKeys: promotedJson && typeof promotedJson === 'object' ? Object.keys(promotedJson) : [],
        strategyRows: promotedRows.length,
        idFieldsObserved: ['setupId', 'strategyId'],
      },
      paperTrades: {
        lineCount,
        parseErrors,
        validTrades: normalizedTrades.length,
        idFieldsObserved: ['setupId', 'strategyId'],
        timeFieldUsed: 'exitTs || ts',
        pnlFieldUsed: 'pnl',
      },
      joinRule: {
        setupKey: 'setupId || strategyId',
        promotedMatchRule:
          'isPromoted if setupId in promoted.setupId OR strategyId in promoted.strategyId OR setupKey in promoted join keys',
      },
    },
    overlapAudit: {
      promotedRows: promotedRows.length,
      paperUniqueSetupKeys: allSetupKeys.size,
      overlapSetupKeys: overlappedSetupKeys.size,
      overlapSetupKeySample: Array.from(overlappedSetupKeys).sort().slice(0, 30),
    },
    windowsAnchor: {
      anchorMarketTs: toIsoOrNull(anchorMs),
      semantics: 'Rolling windows are anchored to max(exitTs||ts) seen in paper_trades.jsonl',
      anchorSimulatedTs: toIsoOrNull(simulatedAnchorMs > 0 ? simulatedAnchorMs : null),
      simulatedSemantics:
        'promoted_and_paper_recent_by_simulatedAt uses max(simulatedAt) wall-clock anchor; does not affect market windows.',
    },
    setupRows: rowsBySetup,
    comparisons: windowComparisons,
    freshnessVsHistory: {
      totalUniqueSetupsAllTime: allSetupKeys.size,
      totalUniqueSetupsLast7d: recentUniqueSetups7d.size,
      setupsFirstSeenLast7d: newSetupsIn7d.size,
      repeatedHistoricalDominanceHint:
        recentUniqueSetups7d.size > 0 ? round(((recentUniqueSetups7d.size - newSetupsIn7d.size) / recentUniqueSetups7d.size) * 100, 4) : null,
    },
    focusSetupCheck: focusCheck,
    strictMappingReport: {
      generatedAt: new Date().toISOString(),
      promotedUniverseCount: promotedCatalog.length,
      paperUniverseCount: rowsBySetup.length,
      overlapCount: Array.from(new Set(rowsBySetup.filter((r) => r.isPromoted).map((r) => r.setupKey))).length,
      promoted_only: promotedOnly,
      paper_only_recent: paperOnlyRecent,
      promoted_and_paper_recent: promotedAndPaperRecent,
      promoted_and_paper_recent_by_simulatedAt: {
        count: promotedAndPaperRecentBySimulatedAt.length,
        sample: promotedAndPaperRecentBySimulatedAt.slice(0, 5),
      },
      simulatedAt_vs_market_recent_diagnostic: {
        market_recent_count: promotedAndPaperRecent.length,
        simulated_recent_count: promotedAndPaperRecentBySimulatedAt.length,
        delta: promotedAndPaperRecentBySimulatedAt.length - promotedAndPaperRecent.length,
      },
      paper_recent_not_promoted_but_profitable: paperRecentNotPromotedButProfitable,
      promoted_not_seen_in_paper_last_7d: promotedNotSeenInPaperLast7d,
    },
    joinDiagnostics: {
      all_time: {
        exact_setupKey_match_count: exactSetupKeyMatchAll.length,
        setupId_only_match_count: setupIdOnlyMatchAll.length,
        strategyId_only_match_count: strategyIdOnlyMatchAll.length,
        promoted_setupId_matches_paper_strategyId: promotedSetupIdMatchesPaperStrategyIdAll.length,
        promoted_strategyId_matches_paper_setupId: promotedStrategyIdMatchesPaperSetupIdAll.length,
      },
      recent_7d: {
        exact_setupKey_match_count: exactSetupKeyMatchRecent.length,
        setupId_only_match_count: promotedCatalog.filter((p) => p.setupId && paperRecentSetupIds.has(p.setupId)).length,
        strategyId_only_match_count: promotedCatalog.filter((p) => p.strategyId && paperRecentStrategyIds.has(p.strategyId)).length,
        promoted_setupId_matches_paper_strategyId: promotedSetupIdMatchesPaperStrategyIdRecent.length,
        promoted_strategyId_matches_paper_setupId: promotedStrategyIdMatchesPaperSetupIdRecent.length,
      },
      prefix_groups: prefixCounts,
      example_cross_field_matches: {
        promoted_setupId_matches_paper_strategyId: promotedSetupIdMatchesPaperStrategyIdRecent.slice(0, 10).map((x) => x.setupId),
        promoted_strategyId_matches_paper_setupId: promotedStrategyIdMatchesPaperSetupIdRecent.slice(0, 10).map((x) => x.strategyId),
      },
      likely_same_strategy_but_mismatched_key: likelySameButMismatched.slice(0, 30),
      no_plausible_match: noPlausibleMatch.slice(0, 30),
    },
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, JSON.stringify(output, null, 2), 'utf8');
  fs.writeFileSync(outCsvPath, buildCsv(rowsBySetup), 'utf8');
  fs.writeFileSync(outStrictJsonPath, JSON.stringify(output.strictMappingReport, null, 2), 'utf8');

  const allCmp = windowComparisons.all_time;
  const last7Cmp = windowComparisons.last_7d;
  const summary = {
    ok: true,
    wrote: { json: outJsonPath, csv: outCsvPath, strictMappingJson: outStrictJsonPath },
    join: output.structureAudit.joinRule,
    overlap: output.overlapAudit,
    allTimePromotedVsNon: {
      promoted: allCmp.promoted,
      nonPromoted: allCmp.nonPromoted,
    },
    last7dPromotedVsNon: {
      promoted: last7Cmp.promoted,
      nonPromoted: last7Cmp.nonPromoted,
    },
    concentrationAllTime: allCmp.concentration,
    concentrationLast7d: last7Cmp.concentration,
    freshnessVsHistory: output.freshnessVsHistory,
    strictMappingCounts: {
      promoted_only: output.strictMappingReport.promoted_only.length,
      paper_only_recent: output.strictMappingReport.paper_only_recent.length,
      promoted_and_paper_recent: output.strictMappingReport.promoted_and_paper_recent.length,
      promoted_and_paper_recent_by_simulatedAt:
        output.strictMappingReport.promoted_and_paper_recent_by_simulatedAt.count,
      paper_recent_not_promoted_but_profitable:
        output.strictMappingReport.paper_recent_not_promoted_but_profitable.length,
      promoted_not_seen_in_paper_last_7d: output.strictMappingReport.promoted_not_seen_in_paper_last_7d.length,
    },
    joinDiagnostics: output.joinDiagnostics,
  };

  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main();
}
