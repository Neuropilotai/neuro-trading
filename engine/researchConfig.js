'use strict';

/**
 * NeuroPilot Quant Engine v1 — Research Config
 *
 * Central configuration for research runs: default account, default dataset definitions,
 * and named dataset groups. Pure config; no file reads, no database writes.
 */

/** Default account for backtests and research (equity, dailyPnL, openPositions). */
const DEFAULT_ACCOUNT = Object.freeze({
  equity: 500,
  dailyPnL: 0,
  openPositions: 0,
});

/**
 * Build dataset definitions for a symbol and timeframes. Path pattern: dataDir/symbolLower_timeframe.ext
 *
 * @param {string} symbol - Symbol (e.g. "QQQ", "SPY")
 * @param {string[]} timeframes - Timeframes (e.g. ["1m", "5m"])
 * @param {object} [opts] - { dataDir: string, extension: string }
 * @returns {Array<{ filePath: string, symbol: string, timeframe: string }>}
 */
function definitionsForSymbol(symbol, timeframes, opts = {}) {
  const dataDir = opts.dataDir != null ? String(opts.dataDir) : './data';
  const ext = opts.extension != null ? String(opts.extension) : 'csv';
  const base = symbol && typeof symbol === 'string' ? symbol : '';
  const list = Array.isArray(timeframes) ? timeframes : [];
  const out = [];
  for (const tf of list) {
    if (typeof tf !== 'string' || !tf) continue;
    const fileName = `${base.toLowerCase()}_${tf}.${ext}`;
    const filePath = dataDir.endsWith('/') ? `${dataDir}${fileName}` : `${dataDir}/${fileName}`;
    out.push({ filePath, symbol: base, timeframe: tf });
  }
  return out;
}

/**
 * Build dataset definitions for one symbol/timeframe with one file per year. Path pattern: dataDir/symbolLower_timeframe_year.ext
 * Use with batchLoader mergeSameSymbolTimeframe so candles are merged into one series. Each def gets options.startMs for that year (synthesis).
 *
 * @param {string} symbol - Symbol (e.g. "SPY")
 * @param {string} timeframe - Timeframe (e.g. "5m")
 * @param {number[]} years - Years (e.g. [2022, 2023, 2024, 2025])
 * @param {object} [opts] - { dataDir: string, extension: string }
 * @returns {Array<{ filePath: string, symbol: string, timeframe: string, options?: { synthesizeTimestampsFromIndex: boolean, startMs: number } }>}
 */
function definitionsForSymbolTimeframeByYears(symbol, timeframe, years, opts = {}) {
  const dataDir = opts.dataDir != null ? String(opts.dataDir) : './data';
  const ext = opts.extension != null ? String(opts.extension) : 'csv';
  const base = symbol && typeof symbol === 'string' ? symbol : '';
  const tf = typeof timeframe === 'string' && timeframe ? timeframe : '';
  const yearList = Array.isArray(years) ? years.filter((y) => Number.isFinite(Number(y))) : [];
  const out = [];
  for (const y of yearList) {
    const fileName = `${base.toLowerCase()}_${tf}_${y}.${ext}`;
    const filePath = dataDir.endsWith('/') ? `${dataDir}${fileName}` : `${dataDir}/${fileName}`;
    const startMs = Date.UTC(Number(y), 0, 2, 14, 30, 0, 0);
    out.push({ filePath, symbol: base, timeframe: tf, options: { synthesizeTimestampsFromIndex: true, startMs } });
  }
  return out;
}

/** Default timeframes used by built-in groups. */
const DEFAULT_TIMEFRAMES = Object.freeze(['1m', '5m']);

/** Years for multi-year SPY 5m group (current default). */
const SPY_5M_YEARS = Object.freeze([2022, 2023, 2024, 2025]);

/** Extended years for SPY/QQQ 5m — goal 50–100+ trades. Add data/spy_5m_2019.csv etc. when ready. */
const SPY_5M_YEARS_EXTENDED = Object.freeze([2019, 2020, 2021, 2022, 2023, 2024, 2025]);
const QQQ_5M_YEARS_EXTENDED = Object.freeze([2019, 2020, 2021, 2022, 2023, 2024, 2025]);

/** Group names that require mergeSameSymbolTimeframe when loading (multiple files per symbol/timeframe). */
const GROUPS_REQUIRING_MERGE = Object.freeze([
  'spy_5m_2022_2025',
  'spy_5m_2019_2025',
  'qqq_5m_2019_2025',
]);

/** Groups that use bar-index-like CSVs and should get synthesizeTimestampsFromIndex in batchLoader.loader (for session breakdown). */
const GROUPS_SYNTHESIZE_TIMESTAMPS = Object.freeze([
  'spy_only',
  'spy_5m_single',
  'qqq_5m_single',
  'spy_5m_2019',
  'spy_5m_2020',
  'spy_5m_2021',
  'spy_5m_2022',
  'spy_5m_2023',
  'spy_5m_2024',
  'spy_5m_2025',
  'qqq_5m_2019',
  'qqq_5m_2020',
  'qqq_5m_2021',
  'qqq_5m_2022',
  'qqq_5m_2023',
  'qqq_5m_2024',
  'qqq_5m_2025',
]);

/** Named dataset groups: each value is an array of dataset definitions. */
const DATASET_GROUPS = Object.freeze({
  qqq_only: definitionsForSymbol('QQQ', DEFAULT_TIMEFRAMES),
  spy_only: definitionsForSymbol('SPY', DEFAULT_TIMEFRAMES),
  nas100_only: definitionsForSymbol('NAS100', DEFAULT_TIMEFRAMES),
  us_indices_core: [
    ...definitionsForSymbol('QQQ', DEFAULT_TIMEFRAMES),
    ...definitionsForSymbol('SPY', DEFAULT_TIMEFRAMES),
  ],
  /** SPY 5m one file per year (2022–2025); use with mergeSameSymbolTimeframe. */
  spy_5m_2022_2025: definitionsForSymbolTimeframeByYears('SPY', '5m', [...SPY_5M_YEARS]),
  /** SPY 5m extended (2019–2025). Add data/spy_5m_2019.csv … spy_5m_2025.csv for 50–100+ trades. */
  spy_5m_2019_2025: definitionsForSymbolTimeframeByYears('SPY', '5m', [...SPY_5M_YEARS_EXTENDED]),
  /** SPY 5m single year — one file each; no merge. */
  spy_5m_2019: definitionsForSymbolTimeframeByYears('SPY', '5m', [2019]),
  spy_5m_2020: definitionsForSymbolTimeframeByYears('SPY', '5m', [2020]),
  spy_5m_2021: definitionsForSymbolTimeframeByYears('SPY', '5m', [2021]),
  spy_5m_2022: definitionsForSymbolTimeframeByYears('SPY', '5m', [2022]),
  spy_5m_2023: definitionsForSymbolTimeframeByYears('SPY', '5m', [2023]),
  spy_5m_2024: definitionsForSymbolTimeframeByYears('SPY', '5m', [2024]),
  spy_5m_2025: definitionsForSymbolTimeframeByYears('SPY', '5m', [2025]),
  /** SPY 5m single file (data/spy_5m.csv). Use when year files are not yet available. */
  spy_5m_single: definitionsForSymbol('SPY', ['5m']),
  /** QQQ 5m single file (data/qqq_5m.csv). */
  qqq_5m_single: definitionsForSymbol('QQQ', ['5m']),
  /** QQQ 5m extended (2019–2025). Add data/qqq_5m_2019.csv … qqq_5m_2025.csv for more trades. */
  qqq_5m_2019_2025: definitionsForSymbolTimeframeByYears('QQQ', '5m', [...QQQ_5M_YEARS_EXTENDED]),
  /** QQQ 5m single year. */
  qqq_5m_2019: definitionsForSymbolTimeframeByYears('QQQ', '5m', [2019]),
  qqq_5m_2020: definitionsForSymbolTimeframeByYears('QQQ', '5m', [2020]),
  qqq_5m_2021: definitionsForSymbolTimeframeByYears('QQQ', '5m', [2021]),
  qqq_5m_2022: definitionsForSymbolTimeframeByYears('QQQ', '5m', [2022]),
  qqq_5m_2023: definitionsForSymbolTimeframeByYears('QQQ', '5m', [2023]),
  qqq_5m_2024: definitionsForSymbolTimeframeByYears('QQQ', '5m', [2024]),
  qqq_5m_2025: definitionsForSymbolTimeframeByYears('QQQ', '5m', [2025]),
  /** XAUUSD (spot gold) 5m / 1h — add datasets/xauusd/xauusd_5m.csv, xauusd_1h.csv manually or via forex provider. */
  xauusd_5m: definitionsForSymbol('XAUUSD', ['5m']),
  xauusd_1h: definitionsForSymbol('XAUUSD', ['1h']),
});

/**
 * Get dataset definitions for a named group. Returns a new array; safe for unknown names.
 *
 * @param {string} name - Group name (e.g. "qqq_only", "us_indices_core")
 * @returns {Array<{ filePath: string, symbol: string, timeframe: string }>}
 */
function getDatasetGroup(name) {
  if (name == null || typeof name !== 'string') return [];
  const key = name.trim();
  if (!Object.prototype.hasOwnProperty.call(DATASET_GROUPS, key)) return [];
  const group = DATASET_GROUPS[key];
  return Array.isArray(group) ? [...group] : [];
}

/**
 * List available dataset group names.
 *
 * @returns {string[]}
 */
function listDatasetGroups() {
  return Object.keys(DATASET_GROUPS);
}

module.exports = {
  DEFAULT_ACCOUNT,
  DATASET_GROUPS,
  DEFAULT_TIMEFRAMES,
  SPY_5M_YEARS,
  SPY_5M_YEARS_EXTENDED,
  QQQ_5M_YEARS_EXTENDED,
  GROUPS_REQUIRING_MERGE,
  GROUPS_SYNTHESIZE_TIMESTAMPS,
  definitionsForSymbol,
  definitionsForSymbolTimeframeByYears,
  getDatasetGroup,
  listDatasetGroups,
};
