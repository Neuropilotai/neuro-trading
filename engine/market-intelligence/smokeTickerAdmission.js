#!/usr/bin/env node
'use strict';

/**
 * Smoke: temp DATA_ROOT + mini datasets_manifest → full chain + ops ticker_discovery.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const dataRoot = require('../dataRoot');
const { writeMarketIntelligence } = require('./buildMarketIntelligence');
const { writeTickerCandidates } = require('./scoreTickerCandidates');
const { writeTickerAdmissionQueue } = require('./buildTickerAdmissionQueue');
const { writeTickerDiscoveryOpsSnapshot } = require('../governance/buildTickerDiscoverySnapshot');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ticker-adm-'));
  const prevEnv = process.env.NEUROPILOT_DATA_ROOT;
  process.env.NEUROPILOT_DATA_ROOT = tmp;
  dataRoot.resetDataRoot();

  try {
    const manifest = {
      datasets: {
        BTCUSDT_5m: { symbol: 'BTCUSDT', timeframe: '5m' },
        BTCUSDT_15m: { symbol: 'BTCUSDT', timeframe: '15m' },
        BTCUSDT_1h: { symbol: 'BTCUSDT', timeframe: '1h' },
        ADAUSDT_5m: { symbol: 'ADAUSDT', timeframe: '5m' },
        ADAUSDT_15m: { symbol: 'ADAUSDT', timeframe: '15m' },
        XRPUSDT_5m: { symbol: 'XRPUSDT', timeframe: '5m' },
        XAUUSD_5m: { symbol: 'XAUUSD', timeframe: '5m' },
      },
    };
    fs.writeFileSync(
      path.join(tmp, 'datasets_manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    const ts = new Date().toISOString();
    writeMarketIntelligence({ dataRoot: tmp, generatedAt: ts });
    writeTickerCandidates({ dataRoot: tmp, generatedAt: ts });
    writeTickerAdmissionQueue({ dataRoot: tmp, generatedAt: ts });

    const miPath = path.join(tmp, 'discovery', 'market_intelligence.json');
    const cPath = path.join(tmp, 'discovery', 'ticker_candidates.json');
    const qPath = path.join(tmp, 'discovery', 'ticker_admission_queue.json');
    assert(fs.existsSync(miPath), 'market_intelligence.json missing');
    assert(fs.existsSync(cPath), 'ticker_candidates.json missing');
    assert(fs.existsSync(qPath), 'ticker_admission_queue.json missing');

    const mi = JSON.parse(fs.readFileSync(miPath, 'utf8'));
    assert(mi.schemaVersion && Array.isArray(mi.universe), 'market_intel shape');
    assert(mi.universe.includes('BTCUSDT') && mi.universe.length === 4, 'universe from manifest only');

    const cand = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    assert(cand.candidates.length === 4, 'candidate count');
    const btc = cand.candidates.find((x) => x.symbol === 'BTCUSDT');
    assert(btc && btc.admissionScore >= 0 && btc.admissionScore <= 100, 'score clamp');
    assert(btc.dataCoverage.hasMinimumSet === true, 'BTC multi-tf');

    const queue = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    const papers = queue.items.filter((i) => i.status === 'paper_candidate');
    assert(papers.length <= 2, 'max 2 paper');
    assert(papers.every((p) => p.paperOnly === true && p.source === 'ticker_discovery_v1'), 'paper flags');

    const opsDir = path.join(tmp, 'ops_snap');
    const { path: snapPath } = writeTickerDiscoveryOpsSnapshot({
      opsSnapshotDir: opsDir,
      dataRoot: tmp,
      generatedAt: ts,
    });
    assert(fs.existsSync(snapPath), 'ticker_discovery.json');
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    assert(snap.summary && typeof snap.summary.paperCandidates === 'number', 'snapshot summary');
    assert(Array.isArray(snap.topCandidates), 'topCandidates');

    console.log('[smokeTickerAdmission] OK', { tmp, snapPath });
    console.log('  paperCandidates in queue:', papers.map((p) => p.symbol).join(', ') || '(none)');
  } finally {
    if (prevEnv === undefined) delete process.env.NEUROPILOT_DATA_ROOT;
    else process.env.NEUROPILOT_DATA_ROOT = prevEnv;
    dataRoot.resetDataRoot();
  }
}

main();
