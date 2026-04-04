#!/usr/bin/env node
'use strict';

/**
 * Split data/spy_5m.csv into 4 year files: spy_5m_2022.csv … spy_5m_2025.csv.
 * Uses row count (no real dates in CSV). Run from repo root or neuropilot_trading_v2.
 * Requires: data/spy_5m.csv
 * Creates: data/spy_5m_2022.csv, data/spy_5m_2023.csv, data/spy_5m_2024.csv, data/spy_5m_2025.csv
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SOURCE = path.join(DATA_DIR, 'spy_5m.csv');
const YEARS = [2022, 2023, 2024, 2025];

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error('Missing', SOURCE);
    process.exit(1);
  }
  const content = fs.readFileSync(SOURCE, 'utf8');
  const lines = content.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    console.error('Not enough lines in', SOURCE);
    process.exit(1);
  }
  const header = lines[0];
  const dataLines = lines.slice(1);
  const total = dataLines.length;
  const perYear = Math.floor(total / YEARS.length);
  if (perYear < 60) {
    console.error('Too few rows per year (min 60). Total rows:', total);
    process.exit(1);
  }

  let start = 0;
  for (let i = 0; i < YEARS.length; i++) {
    const end = i === YEARS.length - 1 ? total : start + perYear;
    const chunk = [header, ...dataLines.slice(start, end)];
    const outPath = path.join(DATA_DIR, `spy_5m_${YEARS[i]}.csv`);
    fs.writeFileSync(outPath, chunk.join('\n'), 'utf8');
    console.log(outPath, chunk.length - 1, 'rows');
    start = end;
  }
  console.log('Done. Run: node engine/exampleRunResearchFromConfig.js spy_5m_2022_2025 trend_breakout');
}

main();
