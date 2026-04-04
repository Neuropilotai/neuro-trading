'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LEARNING_MODES_PATH = path.join(ROOT, 'config', 'learning_modes.json');
const MARKET_UNIVERSE_PATH = path.join(ROOT, 'config', 'market_universe.core.json');
const REGIME_FEATURES_PATH = path.join(ROOT, 'config', 'regime_features.json');

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadLearningModes() {
  return safeReadJson(LEARNING_MODES_PATH, { defaultMode: 'core_3m', modes: {} });
}

function resolveMode(modeName) {
  const cfg = loadLearningModes();
  const mode = modeName || process.env.NEUROPILOT_LEARNING_MODE || cfg.defaultMode || 'core_3m';
  const selected = cfg.modes && cfg.modes[mode] ? cfg.modes[mode] : null;
  if (!selected) {
    throw new Error(`phaseGate: unknown learning mode "${mode}"`);
  }
  return { mode, config: selected };
}

function loadMarketUniverse() {
  const j = safeReadJson(MARKET_UNIVERSE_PATH, { markets: [] });
  const markets = Array.isArray(j.markets) ? j.markets : [];
  return markets.map((m) => ({
    symbol: String(m.symbol || '').toUpperCase(),
    enabled: m.enabled !== false,
    provider: String(m.provider || '').toLowerCase(),
    timeframes: Array.isArray(m.timeframes) ? m.timeframes.map((tf) => String(tf).toLowerCase()) : [],
  })).filter((m) => m.symbol);
}

function resolveActiveUniverse(modeConfig) {
  const maxMarkets = Number.isFinite(Number(modeConfig && modeConfig.maxMarkets))
    ? Math.max(1, Math.floor(Number(modeConfig.maxMarkets)))
    : 2;
  return loadMarketUniverse().filter((m) => m.enabled).slice(0, maxMarkets);
}

function isMarketAllowed(symbol, timeframe, modeConfig) {
  const s = String(symbol || '').toUpperCase();
  const tf = String(timeframe || '').toLowerCase();
  const active = resolveActiveUniverse(modeConfig);
  const m = active.find((x) => x.symbol === s);
  if (!m) return false;
  if (!m.timeframes.length) return true;
  return m.timeframes.includes(tf);
}

function isFamilyAllowed(family, modeConfig) {
  const allowed = Array.isArray(modeConfig && modeConfig.allowedFamilies)
    ? modeConfig.allowedFamilies.map((x) => String(x).toLowerCase())
    : [];
  if (!allowed.length) return true;
  return allowed.includes(String(family || '').toLowerCase());
}

function getLookbackDays(modeConfig) {
  const n = Number(modeConfig && modeConfig.lookbackDays);
  if (!Number.isFinite(n) || n <= 0) return 90;
  return Math.floor(n);
}

function isPaperOnly(modeConfig) {
  return modeConfig && modeConfig.paperOnly === true;
}

function loadRegimeFeatures() {
  return safeReadJson(REGIME_FEATURES_PATH, { tags: [], definitions: {} });
}

function describePhaseA(modeName) {
  const { mode, config } = resolveMode(modeName);
  const universe = resolveActiveUniverse(config);
  const regimes = loadRegimeFeatures();
  return {
    mode,
    lookbackDays: getLookbackDays(config),
    paperOnly: isPaperOnly(config),
    liveTradingEnabled: config.liveTradingEnabled === true,
    maxMarkets: config.maxMarkets,
    maxFamilies: config.maxFamilies,
    allowedFamilies: config.allowedFamilies || [],
    activeMarkets: universe,
    regimeTags: Array.isArray(regimes.tags) ? regimes.tags : [],
  };
}

module.exports = {
  LEARNING_MODES_PATH,
  MARKET_UNIVERSE_PATH,
  REGIME_FEATURES_PATH,
  loadLearningModes,
  resolveMode,
  loadMarketUniverse,
  resolveActiveUniverse,
  isMarketAllowed,
  isFamilyAllowed,
  getLookbackDays,
  isPaperOnly,
  loadRegimeFeatures,
  describePhaseA,
};
