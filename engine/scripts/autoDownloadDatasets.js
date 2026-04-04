#!/usr/bin/env node
'use strict';

/**
 * Auto-download datasets (SPY, QQQ, BTCUSDT 5m) when missing.
 *
 * Uses engine/data/datasetDownloader → Yahoo for SPY/QQQ, Binance for BTCUSDT.
 * After this, run: ./engine/scripts/runDiscoverySpyQqqBtc.sh (convert to binary + two-stage).
 *
 * Usage:
 *   export NEUROPILOT_DATA_ROOT=/Volumes/TradingDrive/NeuroPilotAI
 *   node engine/scripts/autoDownloadDatasets.js
 *
 * Pipeline complet:
 *   node engine/scripts/autoDownloadDatasets.js && ./engine/scripts/runDiscoverySpyQqqBtc.sh
 */

const path = require('path');
const datasetDownloader = require('../data/datasetDownloader');

const DEFAULT_DATASETS = [
  { symbol: 'SPY', timeframe: '5m' },
  { symbol: 'QQQ', timeframe: '5m' },
  { symbol: 'BTCUSDT', timeframe: '5m' },
];

async function run() {
  const dataRoot = datasetDownloader.getDataRoot();
  console.log('Data root:', dataRoot);

  const list = process.argv.slice(2).length > 0
    ? process.argv.slice(2).map((s) => {
        const [sym, tf] = s.split(/[_\s]/);
        return { symbol: sym || 'SPY', timeframe: tf || '5m' };
      })
    : DEFAULT_DATASETS;

  const force = process.env.FORCE_DOWNLOAD === '1';
  const results = await datasetDownloader.downloadAll(list, { force });

  for (const r of results) {
    if (r.provider === 'cached') {
      console.log(r.symbol, r.timeframe, 'dataset already exists →', r.path, '(', r.rows, 'rows )');
    } else {
      console.log(r.symbol, r.timeframe, 'downloaded via', r.provider, '→', r.path, '(', r.rows, 'rows )');
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
