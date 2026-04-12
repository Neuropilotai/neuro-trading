'use strict';

/**
 * Dynamic symbol universe manager — rule-based selection for autonomous scanning.
 * Does not execute trades. Safe, deterministic, auditable.
 *
 * Extension hooks (future): context.newsSignalProvider, macroCalendarProvider, marketRegimeProvider
 */

const fs = require('fs');
const path = require('path');
const macroScoringService = require('./macroScoringService');
const weekendUniversePolicy = require('./weekendUniversePolicy');

const MODULE_VERSION = 1;
const MODULE_VERSION_MACRO = 2;
const SOURCE_ID = 'dynamic_universe_manager';

/** Default CSV when env unset (OANDA-mapped symbols in oandaPriceAdapter). */
const DEFAULT_SYMBOL_CSV = 'XAUUSD,EURUSD,BTCUSD,USDJPY,NAS100USD,SPX500USD';

const DEFAULT_BASE_SYMBOLS_CSV = 'XAUUSD,EURUSD,USDJPY,BTCUSD,NAS100USD,SPX500USD';

/**
 * Extensible symbol metadata (liquidity, class). Unknown symbols are dropped or penalized.
 */
/** tradingSchedule: 24x7 | weekdays | session_based (weekend policy uses 24x7) */
const SYMBOL_METADATA = Object.freeze({
  XAUUSD: {
    assetClass: 'metals',
    enabledByDefault: true,
    liquidityTier: 'high',
    tradingSchedule: 'weekdays',
  },
  EURUSD: {
    assetClass: 'fx',
    enabledByDefault: true,
    liquidityTier: 'high',
    tradingSchedule: 'weekdays',
  },
  GBPUSD: {
    assetClass: 'fx',
    enabledByDefault: true,
    liquidityTier: 'high',
    tradingSchedule: 'weekdays',
  },
  USDJPY: {
    assetClass: 'fx',
    enabledByDefault: true,
    liquidityTier: 'high',
    tradingSchedule: 'weekdays',
  },
  AUDUSD: {
    assetClass: 'fx',
    enabledByDefault: true,
    liquidityTier: 'high',
    tradingSchedule: 'weekdays',
  },
  USDCAD: {
    assetClass: 'fx',
    enabledByDefault: true,
    liquidityTier: 'high',
    tradingSchedule: 'weekdays',
  },
  NZDUSD: {
    assetClass: 'fx',
    enabledByDefault: true,
    liquidityTier: 'medium',
    tradingSchedule: 'weekdays',
  },
  USDCHF: {
    assetClass: 'fx',
    enabledByDefault: true,
    liquidityTier: 'high',
    tradingSchedule: 'weekdays',
  },
  BTCUSD: {
    assetClass: 'crypto',
    enabledByDefault: true,
    liquidityTier: 'medium',
    tradingSchedule: '24x7',
  },
  ETHUSD: {
    assetClass: 'crypto',
    enabledByDefault: true,
    liquidityTier: 'medium',
    tradingSchedule: '24x7',
  },
  LTCUSD: {
    assetClass: 'crypto',
    enabledByDefault: true,
    liquidityTier: 'medium',
    tradingSchedule: '24x7',
  },
  SOLUSD: {
    assetClass: 'crypto',
    enabledByDefault: true,
    liquidityTier: 'medium',
    tradingSchedule: '24x7',
  },
  NAS100USD: {
    assetClass: 'indices',
    enabledByDefault: true,
    liquidityTier: 'high',
    tradingSchedule: 'weekdays',
  },
  SPX500USD: {
    assetClass: 'indices',
    enabledByDefault: true,
    liquidityTier: 'high',
    tradingSchedule: 'weekdays',
  },
});

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function parseBool(v, defaultValue = false) {
  if (v === undefined || v === null || v === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function parseCsv(s) {
  return String(s || '')
    .split(',')
    .map((x) => String(x || '').toUpperCase().trim())
    .filter(Boolean);
}

function normalizeSymbol(sym) {
  return String(sym || '').toUpperCase().trim();
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Merge env + optional overrides (for tests / programmatic use).
 */
function getDynamicUniverseConfig(overrides = {}) {
  const e = process.env;
  const maxActive = parseInt(e.DYNAMIC_UNIVERSE_MAX_ACTIVE || '5', 10);
  const maxWatch = parseInt(e.DYNAMIC_UNIVERSE_MAX_WATCHLIST || '5', 10);
  return {
    enabled: parseBool(e.DYNAMIC_UNIVERSE_ENABLED, false),
    maxActiveSymbols: Number.isFinite(maxActive) && maxActive >= 0 ? maxActive : 5,
    maxWatchlistSymbols: Number.isFinite(maxWatch) && maxWatch >= 0 ? maxWatch : 5,
    baseSymbols: parseCsv(e.DYNAMIC_UNIVERSE_BASE_SYMBOLS || DEFAULT_BASE_SYMBOLS_CSV),
    extraSymbols: parseCsv(e.DYNAMIC_UNIVERSE_EXTRA_SYMBOLS || ''),
    allowCrypto: parseBool(e.DYNAMIC_UNIVERSE_ALLOW_CRYPTO, true),
    allowFx: parseBool(e.DYNAMIC_UNIVERSE_ALLOW_FX, true),
    allowIndices: parseBool(e.DYNAMIC_UNIVERSE_ALLOW_INDICES, true),
    allowMetals: parseBool(e.DYNAMIC_UNIVERSE_ALLOW_METALS, true),
    writeSnapshot: parseBool(e.DYNAMIC_UNIVERSE_WRITE_SNAPSHOT, true),
    snapshotPath: e.DYNAMIC_UNIVERSE_SNAPSHOT_PATH || null,
    suspendedSymbols: parseCsv(e.DYNAMIC_UNIVERSE_SUSPENDED_SYMBOLS || ''),
    macroEnabled: parseBool(e.DYNAMIC_UNIVERSE_MACRO_ENABLED, false),
    newsEnabled: parseBool(e.DYNAMIC_UNIVERSE_NEWS_ENABLED, false),
    calendarEnabled: parseBool(e.DYNAMIC_UNIVERSE_CALENDAR_ENABLED, false),
    macroWriteSnapshot: parseBool(e.DYNAMIC_UNIVERSE_MACRO_WRITE_SNAPSHOT, true),
    macroSnapshotPath: e.DYNAMIC_UNIVERSE_MACRO_SNAPSHOT_PATH || null,
    weekendPolicyEnabled: parseBool(e.DYNAMIC_UNIVERSE_WEEKEND_POLICY_ENABLED, false),
    weekendOnly24x7: parseBool(e.DYNAMIC_UNIVERSE_WEEKEND_ONLY_24X7, true),
    weekendExtraSymbols: parseCsv(e.DYNAMIC_UNIVERSE_WEEKEND_EXTRA_SYMBOLS || ''),
    weekendKeepNon24x7InWatchlist: parseBool(
      e.DYNAMIC_UNIVERSE_WEEKEND_KEEP_NON_24X7_IN_WATCHLIST,
      false
    ),
    universeTimezone: e.DYNAMIC_UNIVERSE_TIMEZONE ? String(e.DYNAMIC_UNIVERSE_TIMEZONE).trim() : null,
    ...overrides,
  };
}

function isAssetClassAllowed(assetClass, config) {
  const a = String(assetClass || '').toLowerCase();
  if (a === 'metals') return config.allowMetals;
  if (a === 'fx') return config.allowFx;
  if (a === 'crypto') return config.allowCrypto;
  if (a === 'indices') return config.allowIndices;
  return false;
}

function liquidityScore(tier) {
  const t = String(tier || '').toLowerCase();
  if (t === 'high') return 0.2;
  if (t === 'medium') return 0.15;
  return 0.1;
}

/**
 * Candidate pool: base ∪ extra, deduped, deterministic order (sorted).
 */
function getDynamicUniverseCandidates(config = null) {
  const c = config || getDynamicUniverseConfig();
  const set = new Set();
  for (const s of [...c.baseSymbols, ...c.extraSymbols]) {
    const n = normalizeSymbol(s);
    if (n) set.add(n);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * On weekend + policy: merge weekend-only extras (must exist in SYMBOL_METADATA).
 */
function getDynamicUniverseCandidatesForBuild(config, context = {}) {
  const base = getDynamicUniverseCandidates(config);
  const wp = weekendUniversePolicy.getWeekendPolicyConfig(config);
  if (!wp.weekendPolicyEnabled) return base;
  const now = context.now ? new Date(context.now) : new Date();
  if (!weekendUniversePolicy.isWeekendForUniverse(now, config)) return base;
  const set = new Set(base);
  for (const s of wp.weekendExtraSymbols || []) {
    const n = normalizeSymbol(s);
    if (n && SYMBOL_METADATA[n]) set.add(n);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Per-symbol score with explainable components (deterministic).
 */
function scoreUniverseCandidate(symbol, context = {}) {
  const config = context.config || getDynamicUniverseConfig();
  const sym = normalizeSymbol(symbol);
  const meta = SYMBOL_METADATA[sym];
  const reasons = [];
  const components = {
    enabledByDefault: 0,
    assetClassAllowed: 0,
    liquidity: 0,
    diversification: 0,
    safetyPenalty: 0,
    suspensionPenalty: 0,
  };

  const suspendedList = context.explicitSuspended || config.suspendedSymbols || [];
  const suspendedSet = new Set(suspendedList.map(normalizeSymbol));
  if (suspendedSet.has(sym)) {
    components.suspensionPenalty = -1;
    reasons.push('explicitly_suspended');
    return {
      symbol: sym,
      assetClass: meta ? meta.assetClass : 'unknown',
      totalScore: 0,
      components,
      reasons,
      decision: 'suspended',
      eligible: false,
    };
  }

  if (!meta) {
    components.safetyPenalty = -0.35;
    reasons.push('unknown_symbol_metadata');
    return {
      symbol: sym,
      assetClass: 'unknown',
      totalScore: 0,
      components,
      reasons,
      decision: 'dropped',
      eligible: false,
    };
  }

  if (meta.enabledByDefault) {
    components.enabledByDefault = 0.2;
    reasons.push('enabled_by_default');
  }

  if (isAssetClassAllowed(meta.assetClass, config)) {
    components.assetClassAllowed = 0.2;
    reasons.push(`${meta.assetClass}_allowed`);
  } else {
    reasons.push(`asset_class_blocked:${meta.assetClass}`);
    return {
      symbol: sym,
      assetClass: meta.assetClass,
      totalScore: 0,
      components,
      reasons,
      decision: 'dropped',
      eligible: false,
    };
  }

  components.liquidity = liquidityScore(meta.liquidityTier);
  reasons.push(`liquidity_${meta.liquidityTier || 'unknown'}`);

  // Diversification: among candidates in same asset class, only the lexicographically first gets full boost.
  const candidates = context.allCandidatesSorted || getDynamicUniverseCandidates(config);
  const sameClass = candidates.filter((s) => SYMBOL_METADATA[normalizeSymbol(s)]?.assetClass === meta.assetClass);
  const firstInClass = sameClass.length && normalizeSymbol(sameClass[0]) === sym;
  components.diversification = firstInClass ? 0.15 : 0.05;
  reasons.push(firstInClass ? 'diversification_primary_in_class' : 'diversification_secondary_in_class');

  const raw =
    components.enabledByDefault +
    components.assetClassAllowed +
    components.liquidity +
    components.diversification +
    components.safetyPenalty +
    components.suspensionPenalty;

  const totalScore = round4(clamp01(raw));

  return {
    symbol: sym,
    assetClass: meta.assetClass,
    totalScore,
    components,
    reasons,
    decision: 'candidate',
    eligible: true,
  };
}

function applyFutureProviderBoosts(scored, context) {
  void context;
  return scored;
}

function mergeMacroIntoRows(phase1Rows, macroPack) {
  const adjMap = new Map((macroPack.adjustedRows || []).map((r) => [r.symbol, r]));
  const baseMap = new Map(phase1Rows.map((r) => [r.symbol, r.totalScore]));
  return phase1Rows.map((row) => {
    const adj = adjMap.get(row.symbol);
    if (!adj || !row.eligible || row.decision === 'suspended') {
      return { ...row, macroAugmented: null };
    }
    return {
      ...row,
      totalScore: adj.score,
      reasons: adj.reasons,
      macroAugmented: adj,
      macroComponents: adj.components,
      basePhase1Score: baseMap.get(row.symbol),
    };
  });
}

/**
 * Full universe build: active / watchlist / suspended / dropped + diagnostics.
 * Phase 2 (macro/news/calendar) is opt-in via DYNAMIC_UNIVERSE_MACRO_ENABLED.
 */
function buildDynamicUniverse(context = {}) {
  const generatedAt = new Date().toISOString();
  try {
    const config = { ...getDynamicUniverseConfig(), ...(context.config || {}) };
    if (config.maxActiveSymbols < 0 || config.maxWatchlistSymbols < 0) {
      return {
        ok: false,
        error: 'invalid_config',
        message: 'maxActiveSymbols and maxWatchlistSymbols must be non-negative',
        generatedAt,
        version: MODULE_VERSION,
        source: SOURCE_ID,
      };
    }

    const explicitSuspended = [
      ...(context.explicitSuspended || []),
      ...(config.suspendedSymbols || []),
    ].map(normalizeSymbol);

    const candidates = getDynamicUniverseCandidatesForBuild(config, context);
    const ctxBase = {
      config,
      explicitSuspended,
      allCandidatesSorted: candidates,
      newsSignalProvider: context.newsSignalProvider || null,
      macroCalendarProvider: context.macroCalendarProvider || null,
      marketRegimeProvider: context.marketRegimeProvider || null,
    };

    const scoredRaw = candidates.map((s) => scoreUniverseCandidate(s, ctxBase));
    let scored = applyFutureProviderBoosts(scoredRaw, context);

    const macroCfg = macroScoringService.getMacroScoringConfig({
      macroEnabled: config.macroEnabled,
      newsEnabled: config.newsEnabled,
      calendarEnabled: config.calendarEnabled,
    });

    let macroPack = null;
    let versionOut = MODULE_VERSION;

    if (macroCfg.macroEnabled) {
      versionOut = MODULE_VERSION_MACRO;
      try {
        macroPack = macroScoringService.buildMacroAdjustedUniverseScores(scored, {
          config: {
            ...macroCfg,
            macroEnabled: true,
            newsEnabled: config.newsEnabled,
            calendarEnabled: config.calendarEnabled,
          },
          now: context.now,
          symbolMetadata: SYMBOL_METADATA,
          calendarResult: context.calendarResult,
          newsResult: context.newsResult,
        });
        scored = mergeMacroIntoRows(scored, macroPack);
      } catch (me) {
        console.warn(`[dynamic_universe_macro] merge_failed: ${me && me.message}`);
        macroPack = {
          macroContext: { enabled: false, newsEnabled: false, calendarEnabled: false, regimeBias: 'neutral', confidence: 0 },
          providerStatus: {},
          providerWarnings: [`macro_merge_failed:${me && me.message}`],
          adjustedRows: [],
          calendarEventsUsed: [],
          newsSignalsUsed: [],
        };
      }
    }

    const suspendedSymbols = [];
    const droppedSymbols = [];
    const reasonsBySymbol = {};
    const eligibleForRanking = [];

    for (const row of scored) {
      reasonsBySymbol[row.symbol] = [...(row.reasons || [])];
      if (row.decision === 'suspended') {
        suspendedSymbols.push(row.symbol);
        continue;
      }
      if (row.decision === 'dropped' || !row.eligible) {
        droppedSymbols.push(row.symbol);
        continue;
      }
      eligibleForRanking.push(row);
    }

    eligibleForRanking.sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      return a.symbol.localeCompare(b.symbol);
    });

    const maxA = config.maxActiveSymbols;
    const maxW = config.maxWatchlistSymbols;
    const nowDate = context.now ? new Date(context.now) : new Date();

    const wknd = weekendUniversePolicy.applyWeekendUniversePolicy(eligibleForRanking, {
      config,
      symbolMetadata: SYMBOL_METADATA,
      now: nowDate,
      maxActive: maxA,
      maxWatchlist: maxW,
    });

    const activeSymbols = wknd.activeSymbols;
    const watchlistSymbols = wknd.watchlistSymbols;

    for (const [sym, rs] of Object.entries(wknd.reasonsPatch || {})) {
      if (!reasonsBySymbol[sym]) reasonsBySymbol[sym] = [];
      reasonsBySymbol[sym] = [...new Set([...(reasonsBySymbol[sym] || []), ...rs])];
    }

    const picked = new Set([...activeSymbols, ...watchlistSymbols]);
    for (const row of eligibleForRanking) {
      if (!picked.has(row.symbol)) droppedSymbols.push(row.symbol);
    }

    const scores = scored.map((row) => {
      let decision = 'dropped';
      if (row.decision === 'suspended') decision = 'suspended';
      else if (activeSymbols.includes(row.symbol)) decision = 'active';
      else if (watchlistSymbols.includes(row.symbol)) decision = 'watchlist';
      else if (row.decision === 'dropped' || !row.eligible) decision = 'dropped';
      const components =
        config.macroEnabled && row.macroComponents ? row.macroComponents : row.components;
      return {
        symbol: row.symbol,
        assetClass: row.assetClass,
        score: row.totalScore,
        decision,
        reasons: reasonsBySymbol[row.symbol] || row.reasons,
        components,
      };
    });

    const snapshotWarnings = [];
    if (wknd.weekendPolicy && Array.isArray(wknd.weekendPolicy.warnings)) {
      for (const w of wknd.weekendPolicy.warnings) {
        snapshotWarnings.push(`weekend:${w}`);
      }
    }
    const droppedUnique = [...new Set(droppedSymbols)].sort((a, b) => a.localeCompare(b));

    const impactedSymbols = [];
    if (macroPack && macroPack.adjustedRows) {
      const baseBySym = new Map(scoredRaw.map((r) => [r.symbol, r.totalScore]));
      for (const ar of macroPack.adjustedRows) {
        const b = baseBySym.get(ar.symbol);
        if (b != null && ar.score > (b || 0) + 1e-6) impactedSymbols.push(ar.symbol);
      }
      impactedSymbols.sort((a, b) => a.localeCompare(b));
    }

    const result = {
      ok: true,
      generatedAt,
      version: versionOut,
      source: SOURCE_ID,
      activeSymbols,
      watchlistSymbols,
      suspendedSymbols: [...new Set(suspendedSymbols)].sort((a, b) => a.localeCompare(b)),
      droppedSymbols: droppedUnique,
      diagnostics: {
        candidateCount: candidates.length,
        selectedCount: activeSymbols.length + watchlistSymbols.length,
        droppedCount: droppedUnique.length,
        reasonsBySymbol,
        snapshotWarnings,
        newsSignalCount:
          macroPack && macroPack.newsSignalsUsed ? macroPack.newsSignalsUsed.length : 0,
        calendarEventCount:
          macroPack && macroPack.calendarEventsUsed ? macroPack.calendarEventsUsed.length : 0,
        impactedSymbols,
        providerWarnings: macroPack ? macroPack.providerWarnings || [] : [],
      },
      scores,
      constraints: {
        maxActiveSymbols: maxA,
        maxWatchlistSymbols: maxW,
      },
      configUsed: sanitizeConfigForSnapshot(config),
    };

    if (macroCfg.macroEnabled && macroPack) {
      result.macroContext = macroPack.macroContext;
      result.providerStatus = macroPack.providerStatus;
      result.inputs = {
        calendarEvents: macroPack.calendarEventsUsed || [],
        newsSignals: macroPack.newsSignalsUsed || [],
      };
    }

    result.weekendPolicy = wknd.weekendPolicy;

    if (config.writeSnapshot) {
      const w = writeDynamicUniverseSnapshot(result, config);
      if (w && w.warning) result.diagnostics.snapshotWarnings.push(w.warning);
    }

    if (macroCfg.macroEnabled && config.macroWriteSnapshot !== false) {
      const wm = writeMacroUniverseSnapshot(result, config);
      if (wm && wm.warning) result.diagnostics.snapshotWarnings.push(wm.warning);
    }

    const logMacro = macroCfg.macroEnabled
      ? ` news=${result.diagnostics.newsSignalCount} calendar=${result.diagnostics.calendarEventCount} warnings=${result.diagnostics.providerWarnings.length}`
      : '';
    console.log(
      `[dynamic_universe] generated active=${activeSymbols.length} watchlist=${watchlistSymbols.length} dropped=${result.droppedSymbols.length} suspended=${suspendedSymbols.length}`
    );
    if (macroCfg.macroEnabled) {
      const bias = (result.macroContext && result.macroContext.regimeBias) || '?';
      const conf = (result.macroContext && result.macroContext.confidence) || 0;
      console.log(
        `[dynamic_universe_macro] regime=${bias} conf=${conf}${logMacro} impacted=${impactedSymbols.length}`
      );
    }

    return result;
  } catch (err) {
    return {
      ok: false,
      error: 'build_failed',
      message: err && err.message ? String(err.message) : String(err),
      generatedAt,
      version: MODULE_VERSION,
      source: SOURCE_ID,
    };
  }
}

function resolveMacroSnapshotPath(config) {
  const rel = config.macroSnapshotPath || 'dynamic_universe_macro_latest.json';
  if (path.isAbsolute(rel)) return rel;
  return path.join(getDataDir(), path.basename(rel));
}

function writeMacroUniverseSnapshot(result, configOverride = null) {
  try {
    const config = configOverride || getDynamicUniverseConfig();
    const target = resolveMacroSnapshotPath(config);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, path: target };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.warn(`[dynamic_universe_macro] snapshot_write_failed: ${msg}`);
    return { ok: false, warning: `macro_snapshot_write_failed:${msg}` };
  }
}

function loadLatestMacroUniverseSnapshot() {
  try {
    const config = getDynamicUniverseConfig();
    const target = resolveMacroSnapshotPath(config);
    if (!fs.existsSync(target)) return null;
    const raw = fs.readFileSync(target, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    console.warn(`[dynamic_universe_macro] snapshot_read_failed: ${e && e.message}`);
    return null;
  }
}

function sanitizeConfigForSnapshot(config) {
  return {
    enabled: config.enabled,
    maxActiveSymbols: config.maxActiveSymbols,
    maxWatchlistSymbols: config.maxWatchlistSymbols,
    baseSymbols: config.baseSymbols,
    extraSymbols: config.extraSymbols,
    allowCrypto: config.allowCrypto,
    allowFx: config.allowFx,
    allowIndices: config.allowIndices,
    allowMetals: config.allowMetals,
    writeSnapshot: config.writeSnapshot,
    macroEnabled: config.macroEnabled,
    newsEnabled: config.newsEnabled,
    calendarEnabled: config.calendarEnabled,
    macroWriteSnapshot: config.macroWriteSnapshot,
    weekendPolicyEnabled: config.weekendPolicyEnabled,
    weekendOnly24x7: config.weekendOnly24x7,
    weekendExtraSymbols: config.weekendExtraSymbols,
    weekendKeepNon24x7InWatchlist: config.weekendKeepNon24x7InWatchlist,
    universeTimezone: config.universeTimezone,
  };
}

function resolveSnapshotPath(config) {
  const rel = config.snapshotPath || 'dynamic_universe_latest.json';
  if (path.isAbsolute(rel)) return rel;
  return path.join(getDataDir(), path.basename(rel));
}

/**
 * Atomic JSON write (temp + rename).
 * @param {object} result - payload to persist
 * @param {object} [configOverride] - merged config from buildDynamicUniverse (must match path used for build)
 */
function writeDynamicUniverseSnapshot(result, configOverride = null) {
  try {
    const config = configOverride || getDynamicUniverseConfig();
    const target = resolveSnapshotPath(config);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, path: target };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.warn(`[dynamic_universe] snapshot_write_failed: ${msg}`);
    return { ok: false, warning: `snapshot_write_failed:${msg}` };
  }
}

function loadLatestDynamicUniverseSnapshot() {
  try {
    const config = getDynamicUniverseConfig();
    const target = resolveSnapshotPath(config);
    if (!fs.existsSync(target)) return null;
    const raw = fs.readFileSync(target, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    console.warn(`[dynamic_universe] snapshot_read_failed: ${e && e.message}`);
    return null;
  }
}

// --- Legacy integration: active_symbol_universe.json + AUTO_ENTRY_SYMBOLS (unchanged when dynamic disabled) ---

function universeFilePath() {
  const override = process.env.ACTIVE_SYMBOL_UNIVERSE_PATH;
  if (override) {
    return path.isAbsolute(override) ? override : path.join(process.cwd(), override);
  }
  return path.join(getDataDir(), 'active_symbol_universe.json');
}

function readUniverseFileSync() {
  const p = universeFilePath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}

/**
 * When DYNAMIC_UNIVERSE_ENABLED=true, active symbols come from buildDynamicUniverse().
 * Otherwise: legacy file → AUTO_ENTRY_SYMBOLS → default list (never overrides env without this flag).
 */
function resolveAutonomousSymbolsSync() {
  const dynCfg = getDynamicUniverseConfig();
  if (dynCfg.enabled) {
    const built = buildDynamicUniverse({});
    if (built && built.ok === true && Array.isArray(built.activeSymbols) && built.activeSymbols.length) {
      return {
        symbols: built.activeSymbols,
        source: 'dynamic_universe_manager',
        reasons: built.diagnostics && built.diagnostics.reasonsBySymbol ? built.diagnostics.reasonsBySymbol : {},
        watchlist: built.watchlistSymbols || [],
        suspendedSymbols: built.suspendedSymbols || [],
        generatedAt: built.generatedAt || null,
        dynamicUniverse: {
          version: built.version,
          constraints: built.constraints,
        },
      };
    }
    console.warn('[dynamic_universe] build failed or empty active set; falling back to legacy symbol resolution');
  }

  const useFile = String(process.env.AUTO_ENTRY_USE_UNIVERSE_FILE || 'true').toLowerCase() !== 'false';

  if (useFile) {
    const file = readUniverseFileSync();
    if (file && Array.isArray(file.activeSymbols) && file.activeSymbols.length) {
      const suspended = new Set(
        (Array.isArray(file.suspendedSymbols) ? file.suspendedSymbols : []).map(normalizeSymbol)
      );
      const active = file.activeSymbols
        .map(normalizeSymbol)
        .filter(Boolean)
        .filter((s) => !suspended.has(s));
      if (active.length) {
        const reasons =
          file.reasons && typeof file.reasons === 'object' && !Array.isArray(file.reasons)
            ? file.reasons
            : {};
        return {
          symbols: active,
          source: 'active_symbol_universe.json',
          reasons,
          watchlist: (Array.isArray(file.watchlist) ? file.watchlist : []).map(normalizeSymbol).filter(Boolean),
          suspendedSymbols: [...suspended],
          generatedAt: file.generatedAt != null ? String(file.generatedAt) : null,
        };
      }
    }
  }

  const envList = process.env.AUTO_ENTRY_SYMBOLS;
  const fallback = parseCsv(envList || DEFAULT_SYMBOL_CSV);
  return {
    symbols: fallback,
    source: envList ? 'AUTO_ENTRY_SYMBOLS' : 'default_symbol_list',
    reasons: {},
    watchlist: [],
    suspendedSymbols: [],
    generatedAt: null,
  };
}

function writeStubUniverseFileSync(options = {}) {
  const p = options.path || universeFilePath();
  const symbols = parseCsv(options.symbolsCsv || DEFAULT_SYMBOL_CSV);
  const payload = {
    generatedAt: new Date().toISOString(),
    activeSymbols: symbols,
    watchlist: [],
    suspendedSymbols: [],
    reasons: {
      XAUUSD: ['liquid commodity proxy', 'macro-sensitive'],
      EURUSD: ['deep FX liquidity', 'USD regime'],
      BTCUSD: ['crypto risk-on sleeve'],
      USDJPY: ['rates / USDJPY flow'],
      NAS100USD: ['US tech beta'],
      SPX500USD: ['US broad equity beta'],
    },
  };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

module.exports = {
  MODULE_VERSION,
  MODULE_VERSION_MACRO,
  SOURCE_ID,
  DEFAULT_SYMBOL_CSV,
  SYMBOL_METADATA,
  getDataDir,
  parseCsv,
  getDynamicUniverseConfig,
  getDynamicUniverseCandidates,
  getDynamicUniverseCandidatesForBuild,
  scoreUniverseCandidate,
  buildDynamicUniverse,
  writeDynamicUniverseSnapshot,
  loadLatestDynamicUniverseSnapshot,
  loadLatestMacroUniverseSnapshot,
  universeFilePath,
  resolveAutonomousSymbolsSync,
  writeStubUniverseFileSync,
};
