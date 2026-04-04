/**
 * Brain Dir — single versioned location for all learned state.
 * BRAIN_DIR = /data/brain (Railway) | /TradingDrive/NeuroPilot/brain (Mac) | Google Drive
 * Structure: ledger.sqlite, research.sqlite, exports/, snapshots/, manifest.json
 */

const path = require('path');
const fs = require('fs');

function getBrainDir() {
  const d = process.env.BRAIN_DIR;
  if (!d || typeof d !== 'string') return null;
  return path.resolve(d.trim());
}

function getLedgerPath() {
  const brain = getBrainDir();
  if (brain) return path.join(brain, 'ledger.sqlite');
  return process.env.LEDGER_DB_PATH || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'trade_ledger.db');
}

/**
 * Research DB path: single canonical path for research.sqlite.
 * Priority: RESEARCH_DB_PATH (explicit) > BRAIN_DIR/research.sqlite > DATA_DIR/brain/research.sqlite.
 * No cwd/data fallback — avoids mismatch where WEB and worker point at different DBs (e.g. backtest_id in one, trades [] in the other).
 */
function getResearchPath() {
  if (process.env.RESEARCH_DB_PATH && typeof process.env.RESEARCH_DB_PATH === 'string') {
    return path.resolve(process.env.RESEARCH_DB_PATH.trim());
  }
  const brainDir = getBrainDir();
  const base = brainDir || (process.env.DATA_DIR && typeof process.env.DATA_DIR === 'string'
    ? path.join(path.resolve(process.env.DATA_DIR.trim()), 'brain')
    : null);
  return base ? path.join(base, 'research.sqlite') : null;
}

function getSnapshotsDir() {
  const brain = getBrainDir();
  if (!brain) return null;
  return path.join(brain, 'snapshots');
}

function getExportsDir() {
  const brain = getBrainDir();
  if (!brain) return null;
  return path.join(brain, 'exports');
}

function getManifestPath() {
  const brain = getBrainDir();
  if (!brain) return null;
  return path.join(brain, 'manifest.json');
}

/** Strategies catalogue: manifest + summary + sources (read-only .pine and extracted embedded). */
function getStrategiesDir() {
  const brain = getBrainDir();
  if (!brain) return null;
  return path.join(brain, 'strategies');
}

function getStrategiesManifestPath() {
  const dir = getStrategiesDir();
  if (!dir) return null;
  return path.join(dir, 'strategies_manifest.json');
}

function getStrategiesSummaryPath() {
  const dir = getStrategiesDir();
  if (!dir) return null;
  return path.join(dir, 'STRATEGIES_MANIFEST_SUMMARY.md');
}

function getStrategiesSourcesDir() {
  const dir = getStrategiesDir();
  if (!dir) return null;
  return path.join(dir, 'sources');
}

function ensureBrainDirs() {
  const brain = getBrainDir();
  if (!brain) return;
  const dirs = [
    brain,
    getSnapshotsDir(),
    getExportsDir(),
    getStrategiesDir(),
    getStrategiesSourcesDir(),
  ].filter(Boolean);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  getBrainDir,
  getLedgerPath,
  getResearchPath,
  getSnapshotsDir,
  getExportsDir,
  getManifestPath,
  getStrategiesDir,
  getStrategiesManifestPath,
  getStrategiesSummaryPath,
  getStrategiesSourcesDir,
  ensureBrainDirs,
};
