#!/usr/bin/env node
'use strict';

/**
 * Smoke: promoted_manifest_coverage cohort rollup + top winners/losers.
 * Run: node engine/governance/smokePromotedManifestCoverage.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildPromotedManifestCoverage,
  buildPaperSummaryForManifestSetupIds,
  buildPaperRealityCheck,
} = require('./buildPromotedManifestCoverage');

const tmp = path.join(__dirname, '..', '..', `.tmp-smoke-pmc-${Date.now()}`);
const root = tmp;
const discoveryDir = path.join(root, 'discovery');
const governanceDir = path.join(root, 'governance');
fs.mkdirSync(discoveryDir, { recursive: true });
fs.mkdirSync(governanceDir, { recursive: true });

fs.writeFileSync(
  path.join(discoveryDir, 'promoted_children.json'),
  JSON.stringify({
    strategies: [
      { setupId: 'cohort_winner', rules: { x: 1 } },
      { setupId: 'cohort_loser', rules: { x: 1 } },
      { setupId: 'cohort_no_paper', rules: { x: 1 } },
    ],
  }),
  'utf8'
);

fs.writeFileSync(
  path.join(discoveryDir, 'promoted_manifest.json'),
  JSON.stringify({
    manifestSchemaVersion: '1.0.0',
    items: [
      { setupId: 'cohort_winner', strategyId: 'cohort_winner', rules: { x: 1 } },
      { setupId: 'cohort_loser', strategyId: 'cohort_loser', rules: { x: 1 } },
    ],
    skipped: [{ setupId: 'x', reasonCode: 'TEST_SKIP' }],
    paperGate: {
      enabled: true,
      thresholdsApplied: {
        minTrades: 100,
        minTotalPnl: -1000,
        minAvgPnl: -0.05,
        minWinRate: 30,
      },
      evaluatedStrategies: 12,
      noPaperMetricsRowCount: 3,
      belowMinTradesCount: 5,
      skippedByReason: {
        PAPER_GATE_TOTAL_PNL_TOO_LOW: 2,
      },
    },
  }),
  'utf8'
);

const byStrategyFile = {
  aggregation: 'by_strategy',
  buckets: [
    {
      strategyId: 'cohort_winner',
      trades: 10,
      wins: 8,
      losses: 2,
      winRate: 80,
      totalPnl: 100,
      avgPnl: 10,
    },
    {
      strategyId: 'cohort_loser',
      trades: 4,
      wins: 1,
      losses: 3,
      winRate: 25,
      totalPnl: -40,
      avgPnl: -10,
    },
  ],
};

const r = buildPromotedManifestCoverage({
  dataRoot: root,
  write: false,
  paperTradesByStrategyFile: byStrategyFile,
});

assert.strictEqual(r.doc.coverageSchemaVersion, 4);
const pc = r.doc.promotedCohortPaperSummary;
assert.ok(pc && typeof pc === 'object');
assert.strictEqual(pc.cohortDefinition, 'manifestDistinctSetupIds_only');
assert.ok(pc.totalPnl != null);
assert.strictEqual(pc.topWinnerSetupId, 'cohort_winner');
assert.strictEqual(pc.topLoserSetupId, 'cohort_loser');
assert.ok(Number(pc.topWinnerTotalPnl) > Number(pc.topLoserTotalPnl));
const pl = r.doc.promotedCohortPaperLeaders;
assert.ok(pl.winners && pl.winners.length >= 1);
assert.ok(pl.losers && pl.losers.length >= 1);

const s = r.doc.paperSummaryForManifestSetupIds;
assert.strictEqual(s.distinctSetupIdsWithPaper, 2);
assert.strictEqual(s.distinctSetupIdsWithoutPaper, 0);
assert.strictEqual(s.trades, 14);
assert.strictEqual(s.manifestProducerSkippedCount, 1);
assert.ok(Math.abs(s.totalPnl - 60) < 1e-6);
assert.ok(s.winRate != null && s.winRate > 0 && s.winRate < 100);

assert.strictEqual(r.doc.topPromotedWinnersByPnl[0].setupId, 'cohort_winner');
assert.strictEqual(r.doc.topPromotedLosersByPnl[0].setupId, 'cohort_loser');

const slice = r.doc.paperTradesMetricsByStrategy.byStrategyId.cohort_winner;
assert.strictEqual(slice.wins, 8);
assert.strictEqual(slice.avgPnl, 10);
assert.ok(r.doc.paperGate && typeof r.doc.paperGate === 'object');
assert.strictEqual(r.doc.paperGate.enabled, true);
assert.strictEqual(r.doc.paperGate.evaluatedStrategies, 12);
assert.strictEqual(r.doc.paperGate.belowMinTradesCount, 5);
assert.strictEqual(r.doc.paperGate.skippedByReason.PAPER_GATE_TOTAL_PNL_TOO_LOW, 2);

const prc = r.doc.paperRealityCheck;
assert.ok(prc && typeof prc === 'object');
assert.strictEqual(prc.paperRealityCheckSchemaVersion, '1.0.0');
assert.strictEqual(prc.singleManifestedSetupWithPaper, false);
assert.strictEqual(prc.manifestCohortTooNarrowForRanking, false);
assert.strictEqual(prc.sources.byDayFilePresent, false);
assert.strictEqual(prc.sources.byCycleFilePresent, false);

const byDayFile = {
  aggregation: 'by_day',
  validTradeCount: 100,
  buckets: [
    { day: '2026-01-10', trades: 25, wins: 25, losses: 0, winRate: 100, totalPnl: 10 },
    { day: '2026-01-11', trades: 30, wins: 0, losses: 30, winRate: 0, totalPnl: -5 },
    { day: '2026-01-12', trades: 5, wins: 3, losses: 2, winRate: 60, totalPnl: 1 },
  ],
};
const byCycleFile = {
  aggregation: 'by_cycle',
  validTradeCount: 100,
  buckets: [
    { cycleKey: '_unknown_cycle', trades: 60, winRate: 40, totalPnl: 0 },
    { cycleKey: 'exp_x', trades: 40, winRate: 50, totalPnl: 1 },
  ],
};
const prc2 = buildPaperRealityCheck({
  promotedCohortPaperSummary: r.doc.promotedCohortPaperSummary,
  manifestDistinctIds: r.doc.manifestDistinctSetupIds,
  byId: r.doc.paperTradesMetricsByStrategy.byStrategyId,
  byDayFile,
  byCycleFile,
});
assert.strictEqual(prc2.sources.byDayFilePresent, true);
assert.strictEqual(prc2.sources.byCycleFilePresent, true);
assert.strictEqual(prc2.tradesMissingCycleKeyShare, 0.6);
assert.strictEqual(prc2.unknownCycleDominant, true);
assert.strictEqual(prc2.cycleCoverageLow, true);
const winDay = prc2.suspiciousDays.find((d) => d.reasonCode === 'suspicious_full_win_day');
const lossDay = prc2.suspiciousDays.find((d) => d.reasonCode === 'suspicious_full_loss_day');
assert.ok(winDay && winDay.day === '2026-01-10');
assert.ok(lossDay && lossDay.day === '2026-01-11');

fs.writeFileSync(
  path.join(discoveryDir, 'promoted_manifest.json'),
  JSON.stringify({
    manifestSchemaVersion: '1.0.0',
    items: [{ setupId: 'only_setup', strategyId: 'only_setup', rules: {} }],
    skipped: [],
  }),
  'utf8'
);
const rSingle = buildPromotedManifestCoverage({
  dataRoot: root,
  write: false,
  paperTradesByStrategyFile: {
    aggregation: 'by_strategy',
    buckets: [
      {
        strategyId: 'only_setup',
        trades: 100,
        wins: 50,
        losses: 50,
        winRate: 50,
        totalPnl: 0,
        avgPnl: 0,
      },
    ],
  },
  paperTradesByDayFile: byDayFile,
  paperTradesByCycleFile: byCycleFile,
});
assert.strictEqual(rSingle.doc.promotedCohortPaperSummary.distinctSetupIdsWithPaper, 1);
assert.strictEqual(rSingle.doc.paperRealityCheck.singleManifestedSetupWithPaper, true);
assert.strictEqual(rSingle.doc.paperRealityCheck.manifestCohortTooNarrowForRanking, true);
assert.strictEqual(rSingle.doc.paperRealityCheck.highSingleSetupConcentration, true);

const unit = buildPaperSummaryForManifestSetupIds(['a', 'b'], { a: null, b: { trades: 2, wins: 1, losses: 1, totalPnl: 3, winRate: 50, avgPnl: 1.5 } });
assert.strictEqual(unit.distinctSetupIdsWithoutPaper, 1);
assert.strictEqual(unit.distinctSetupIdsWithPaper, 1);
assert.strictEqual(unit.trades, 2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('smokePromotedManifestCoverage: all passed');
