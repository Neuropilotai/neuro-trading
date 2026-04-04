#!/usr/bin/env node
'use strict';

/**
 * Data + orchestration only: plan multi-market Wave1 expansion from strategy_validation,
 * write multiMarket hints on setup_*.json, optionally append dashboard templates to promoted_children.
 * Does not modify buildPromotedManifest.js, runPaperExecutionV1.js, simulator, or promotionGuard logic.
 *
 * Usage:
 *   node engine/governance/expandMultiMarketWave1.js [--write-setups] [--append-promoted-templates]
 *
 * Env:
 *   NEUROPILOT_DATA_ROOT — default via dataRoot
 *   NEUROPILOT_STRATEGY_VALIDATION_PATH — optional override (JSON file)
 *   NEUROPILOT_REPO_ROOT — default: parent of neuropilot_trading_v2 (engine/../..)
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

const PRIORITY_SETUP_IDS = [
  'ORB_breakout_v1',
  'EMA_pullback_v2',
  'ICT_liquidity_sweep_v1',
  'FVG_scalp_v1',
  'mut_2eeabe_open_e54a0f',
  'mut_c69b7f_close_95c273',
  'mut_90f6ef_close_3e4357',
  'mut_defe24_close_4d7db3',
];

/** Prefer crypto + XAU, then equities (must match user allowlist intent). */
const SYMBOL_PRIORITY = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XAUUSD', 'SPY', 'QQQ'];

const MAX_NEW_MARKETS = 3;
const DEFAULT_TF = '5m';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function resolveRepoRoot() {
  const env = process.env.NEUROPILOT_REPO_ROOT;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  /** v2 package root (contains ops-snapshot/) */
  return path.resolve(__dirname, '..', '..');
}

function resolveValidationPath(root) {
  const env = process.env.NEUROPILOT_STRATEGY_VALIDATION_PATH;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  const p = path.join(root, 'ops-snapshot', 'strategy_validation.json');
  return fs.existsSync(p) ? p : null;
}

function rowExpandable(row) {
  if (!row || typeof row !== 'object') return false;
  const trades = Number(row.trades);
  if (!Number.isFinite(trades) || trades >= 100) return false;
  if (String(row.tier || '').toLowerCase() !== 'reject') return false;
  const hf = Array.isArray(row.hardFails) ? row.hardFails.map(String) : [];
  const br = Array.isArray(row.blockingReasons) ? row.blockingReasons.map(String) : [];
  const blob = `${hf.join(' ')} ${br.join(' ')}`;
  return (
    blob.includes('single_market_required') ||
    blob.includes('too_few_trades_hard')
  );
}

function validationRowsByStrategyId(validationPath) {
  const map = new Map();
  if (!validationPath) return map;
  const doc = safeReadJson(validationPath);
  const rows = doc && Array.isArray(doc.rows) ? doc.rows : [];
  for (const row of rows) {
    const sid = row && row.strategyId != null ? String(row.strategyId).trim() : '';
    if (sid) map.set(sid, row);
  }
  return map;
}

function listSymbolsWithBin5m(dataRootAbs, manifest) {
  const out = [];
  const ds = manifest && manifest.datasets && typeof manifest.datasets === 'object' ? manifest.datasets : {};
  const key5 = (s) => `${String(s).toUpperCase()}_${DEFAULT_TF}`;
  for (const sym of SYMBOL_PRIORITY) {
    const su = String(sym).toUpperCase();
    const entry = ds[key5(su)];
    if (!entry || !entry.paths || !entry.paths.bin) continue;
    const binPath = entry.paths.bin;
    const abs = path.isAbsolute(binPath) ? binPath : path.join(dataRootAbs, binPath);
    if (fs.existsSync(abs)) out.push(su);
  }
  return out;
}

function pickMultiMarket(validationRow, allowedSyms) {
  const existing = new Set();
  if (validationRow && Array.isArray(validationRow.symbols)) {
    for (const s of validationRow.symbols) {
      const u = String(s || '').toUpperCase().trim();
      if (u) existing.add(u);
    }
  }
  const picked = [];
  for (const sym of allowedSyms) {
    if (existing.has(sym)) continue;
    picked.push({ symbol: sym, timeframe: DEFAULT_TF });
    if (picked.length >= MAX_NEW_MARKETS) break;
  }
  return { existing: [...existing], multiMarket: picked };
}

function writeSetupMultiMarket(setupPath, multiMarket, setupId) {
  const raw = readJson(setupPath);
  if (!raw || typeof raw !== 'object') return false;
  if (String(raw.setupId || '').trim() !== setupId) return false;
  raw.multiMarket = multiMarket;
  fs.writeFileSync(setupPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return true;
}

function dashboardTemplateRules(setupId) {
  return { paper_v1_contract: setupId };
}

function templatePromotionRow(setupId) {
  const now = new Date().toISOString();
  return {
    setupId,
    name: 'setup',
    rules: dashboardTemplateRules(setupId),
    source: 'dashboard_wave1_expansion',
    generation: 0,
    parentSetupId: 'dashboard_template_root',
    parentFamilyId: 'dashboard|template|wave1',
    mutationType: 'none',
    expectancy: 0,
    trades: 0,
    winRate: 0,
    beats_parent: false,
    parent_vs_child_score: 0,
    familyKey: 'dashboard_template',
    distinctBatchFiles: 0,
    promotion_breadth_score: 0,
    firstPromotedAt: now,
    promotedAt: now,
    promotionReason: 'wave1_multi_market_coverage',
    promotionGuard: {
      eligible: true,
      target: 'paper',
      mode: 'core_3m',
      reasons: [],
      thresholdsApplied: {
        minTrades: 40,
        minExpectancy: 0,
        maxDrawdownPct: 25,
        minProfitFactor: 1.05,
        maxTopTradesConcentrationPct: 0.65,
        requireWalkForward: true,
      },
      metricsSnapshot: {
        trades: 0,
        expectancy: 0,
        drawdownPct: 0,
        profitFactor: 1,
        topTradesConcentrationPct: 0,
        walkForwardPass: true,
        baseScore: 0,
        adjustedScore: 0,
        contextScoreDelta: 0,
      },
      contextApplied: false,
      marketContext: {
        regime: 'unknown',
        volatility: null,
        trendStrength: null,
        session: 'asia',
      },
      contextAlignment: {
        hasRegimeAlignment: false,
        hasRegimeMismatch: false,
        hasSessionAlignment: false,
        hasSessionMismatch: false,
      },
      contextScoreDelta: 0,
    },
    familyLeader: true,
    promotedLeader: true,
  };
}

function appendDashboardTemplates(promotedPath, templateIds) {
  const doc = safeReadJson(promotedPath);
  if (!doc || typeof doc !== 'object') {
    console.error('[expandMultiMarketWave1] missing promoted_children:', promotedPath);
    return false;
  }
  const strategies = Array.isArray(doc.strategies) ? doc.strategies : [];
  const have = new Set(strategies.map((r) => (r && r.setupId ? String(r.setupId).trim() : '')));
  let added = 0;
  for (const sid of templateIds) {
    if (have.has(sid)) continue;
    strategies.push(templatePromotionRow(sid));
    have.add(sid);
    added += 1;
  }
  doc.strategies = strategies;
  fs.writeFileSync(promotedPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log('[expandMultiMarketWave1] promoted_children appended rows:', added);
  return true;
}

function main() {
  const argv = new Set(process.argv.slice(2).map((a) => String(a).toLowerCase()));
  const writeSetups = argv.has('--write-setups') || argv.size === 0;
  const appendPromoted = argv.has('--append-promoted-templates');

  const rootAbs = dataRoot.getDataRoot();
  const repoRoot = resolveRepoRoot();
  const validationPath = resolveValidationPath(repoRoot);
  const valMap = validationRowsByStrategyId(validationPath);

  const manifestPath = path.join(rootAbs, 'datasets_manifest.json');
  const manifest = safeReadJson(manifestPath) || {};
  const allowedSyms = listSymbolsWithBin5m(rootAbs, manifest);

  const expandableSetups = [];
  for (const row of valMap.values()) {
    if (rowExpandable(row)) {
      const sid = String(row.strategyId || '').trim();
      if (sid) expandableSetups.push(sid);
    }
  }

  const expansionPlan = [];
  const generatedDir = path.join(rootAbs, 'generated_strategies');

  const DASHBOARD_TEMPLATE_IDS = [
    'ORB_breakout_v1',
    'EMA_pullback_v2',
    'ICT_liquidity_sweep_v1',
    'FVG_scalp_v1',
  ];

  for (const setupId of PRIORITY_SETUP_IDS) {
    const valRow = valMap.get(setupId) || null;
    const { existing, multiMarket } = pickMultiMarket(valRow, allowedSyms);
    const setupPath = path.join(generatedDir, `setup_${setupId}.json`);
    const isTemplate = DASHBOARD_TEMPLATE_IDS.includes(setupId);

    expansionPlan.push({
      setupId,
      expandableFromValidation: rowExpandable(valRow),
      validationSymbols: existing,
      multiMarket,
      setupFile: setupPath,
    });

    if (!writeSetups) continue;

    if (isTemplate && !fs.existsSync(setupPath)) {
      ensureDir(generatedDir);
      const doc = {
        setupId,
        strategyId: setupId,
        direction: 'long',
        rMultiple: 2,
        rules: dashboardTemplateRules(setupId),
        multiMarket,
      };
      fs.writeFileSync(setupPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      console.log('[expandMultiMarketWave1] created', path.basename(setupPath));
    } else if (fs.existsSync(setupPath)) {
      writeSetupMultiMarket(setupPath, multiMarket, setupId);
      console.log('[expandMultiMarketWave1] updated multiMarket', setupId, multiMarket.map((m) => m.symbol).join(','));
    } else {
      console.warn('[expandMultiMarketWave1] skip missing setup file:', setupPath);
    }
  }

  if (appendPromoted) {
    const promotedPath = path.join(rootAbs, 'discovery', 'promoted_children.json');
    appendDashboardTemplates(promotedPath, [
      'ORB_breakout_v1',
      'EMA_pullback_v2',
      'ICT_liquidity_sweep_v1',
      'FVG_scalp_v1',
    ]);
  }

  const audit = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    validationPath: validationPath || null,
    allowedSymbols5mBin: allowedSyms,
    expandableSetups,
    expansionPlan,
    prioritySetupIds: PRIORITY_SETUP_IDS,
  };
  const govDir = path.join(rootAbs, 'governance');
  ensureDir(govDir);
  fs.writeFileSync(path.join(govDir, 'multi_market_expansion_audit.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  console.log('[expandMultiMarketWave1] audit', path.join(govDir, 'multi_market_expansion_audit.json'));
}

main();
