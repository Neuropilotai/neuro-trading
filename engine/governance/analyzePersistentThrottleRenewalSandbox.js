#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function toMs(v) {
  const t = new Date(String(v || '')).getTime();
  return Number.isFinite(t) ? t : null;
}

function buildPKey(signal, datasets) {
  const dk = signal.datasetKey != null ? String(signal.datasetKey).trim() : '';
  const sid = String(signal.strategyId || signal.setupId || '').trim();
  const ds = datasets[String(signal.datasetKey || '')] || {};
  const sym = String(signal.symbol || ds.symbol || '').toUpperCase().trim();
  const tf = String(signal.timeframe || ds.timeframe || '').trim();
  const bi = Number(signal.barIndex);
  const barPart = Number.isFinite(bi) ? String(Math.floor(bi)) : 'na';
  return `${dk || 'na'}|${sid}|${sym}|${tf}|${barPart}`;
}

function parsePKey(key) {
  const parts = String(key || '').split('|');
  return {
    datasetKey: parts[0] || '',
    strategyId: parts[1] || '',
    symbol: parts[2] || '',
    timeframe: parts[3] || '',
    barIndex: Number(parts[4]),
  };
}

function parentKeyWithoutBar(signal, datasets) {
  const dk = signal.datasetKey != null ? String(signal.datasetKey).trim() : '';
  const sid = String(signal.strategyId || signal.setupId || '').trim();
  const ds = datasets[String(signal.datasetKey || '')] || {};
  const sym = String(signal.symbol || ds.symbol || '').toUpperCase().trim();
  const tf = String(signal.timeframe || ds.timeframe || '').trim();
  return `${dk || 'na'}|${sid}|${sym}|${tf}`;
}

function summarize(name, signals, passSet, seenKeys, promotedKeySet) {
  let promotedPass = 0;
  let nonPromotedPass = 0;
  let promotedReplay = 0;
  let nonPromotedReplay = 0;
  for (const s of signals) {
    const pkey = s._pkey;
    if (!passSet.has(pkey)) continue;
    const isPromoted = promotedKeySet.has(String(s.setupId || s.strategyId || '').trim());
    const seen = Boolean(seenKeys[pkey]);
    if (isPromoted) {
      promotedPass += 1;
      if (seen) promotedReplay += 1;
    } else {
      nonPromotedPass += 1;
      if (seen) nonPromotedReplay += 1;
    }
  }
  return {
    strategy: name,
    promoted_pass_rows: promotedPass,
    non_promoted_pass_rows: nonPromotedPass,
    total_pass_rows: promotedPass + nonPromotedPass,
    promoted_replay_rows: promotedReplay,
    non_promoted_replay_rows: nonPromotedReplay,
    total_replay_rows: promotedReplay + nonPromotedReplay,
  };
}

function main() {
  const root = dataRoot.getDataRoot();
  const gov = path.join(root, 'governance');
  const discovery = path.join(root, 'discovery');

  const signalsDoc = safeReadJson(path.join(gov, 'paper_execution_v1_signals.json')) || {};
  const seenStore = safeReadJson(path.join(gov, 'paper_exec_seen_keys.json')) || {};
  const promotedChildren = safeReadJson(path.join(discovery, 'promoted_children.json')) || {};
  const datasetsManifest = safeReadJson(path.join(root, 'datasets_manifest.json')) || {};
  const strictMapping = safeReadJson(path.join(gov, 'paper_trades_strict_mapping_report.json')) || {};

  const seenKeys = seenStore.keys && typeof seenStore.keys === 'object' ? seenStore.keys : {};
  const datasets = datasetsManifest.datasets && typeof datasetsManifest.datasets === 'object'
    ? datasetsManifest.datasets
    : {};
  const signals = Array.isArray(signalsDoc.signals) ? signalsDoc.signals : [];
  const promotedKeySet = new Set(
    (Array.isArray(promotedChildren.strategies) ? promotedChildren.strategies : [])
      .map((x) => String((x && x.setupId) || (x && x.strategyId) || '').trim())
      .filter(Boolean)
  );

  for (const s of signals) {
    s._pkey = buildPKey(s, datasets);
    s._parent = parentKeyWithoutBar(s, datasets);
  }

  const now = Date.now();
  const ttlMs = {
    ttl_24h: 24 * 60 * 60 * 1000,
    ttl_72h: 72 * 60 * 60 * 1000,
    ttl_168h: 168 * 60 * 60 * 1000,
  };

  // Build parent->maxSeenBarIndex map from existing keys.
  const maxSeenByParent = {};
  for (const k of Object.keys(seenKeys)) {
    const p = parsePKey(k);
    const parent = `${p.datasetKey}|${p.strategyId}|${p.symbol}|${p.timeframe}`;
    const bi = Number(p.barIndex);
    if (!Number.isFinite(bi)) continue;
    if (maxSeenByParent[parent] == null || bi > maxSeenByParent[parent]) {
      maxSeenByParent[parent] = bi;
    }
  }

  const strategyPassSets = {};

  // Baseline: only unseen keys pass.
  strategyPassSets.baseline_current = new Set(
    signals.filter((s) => !seenKeys[s._pkey]).map((s) => s._pkey)
  );

  // TTL strategies.
  for (const [name, ms] of Object.entries(ttlMs)) {
    strategyPassSets[name] = new Set(
      signals.filter((s) => {
        const rec = seenKeys[s._pkey];
        if (!rec) return true;
        const firstSeenMs = toMs(rec.firstSeenAt);
        if (firstSeenMs == null) return false;
        return now - firstSeenMs >= ms;
      }).map((s) => s._pkey)
    );
  }

  // Cycle scope sandbox: all keys not stamped with current cycle are passable.
  const targetCycle = process.env.NEUROPILOT_CYCLE_ID || 'sandbox_cycle_probe';
  strategyPassSets.cycle_scope = new Set(
    signals.filter((s) => {
      const rec = seenKeys[s._pkey];
      if (!rec) return true;
      const c = rec.cycleId != null ? String(rec.cycleId) : '';
      return c !== targetCycle;
    }).map((s) => s._pkey)
  );

  // Bar advancement scope: pass only if barIndex advances beyond max seen for same parent key.
  strategyPassSets.bar_advancement_scope = new Set(
    signals.filter((s) => {
      const bi = Number(s.barIndex);
      if (!Number.isFinite(bi)) return false;
      const maxSeen = maxSeenByParent[s._parent];
      if (maxSeen == null) return true;
      return bi > maxSeen;
    }).map((s) => s._pkey)
  );

  // Promoted allowlist only: promoted rows may replay, others baseline.
  strategyPassSets.promoted_allowlist = new Set(
    signals.filter((s) => {
      const setupKey = String(s.setupId || s.strategyId || '').trim();
      if (promotedKeySet.has(setupKey)) return true;
      return !seenKeys[s._pkey];
    }).map((s) => s._pkey)
  );

  const strategySummaries = Object.entries(strategyPassSets)
    .map(([name, passSet]) => summarize(name, signals, passSet, seenKeys, promotedKeySet))
    .sort((a, b) => a.total_replay_rows - b.total_replay_rows || b.promoted_pass_rows - a.promoted_pass_rows);

  // Best pragmatic candidate: maximize promoted pass rows with minimum replay rows.
  const ranked = strategySummaries
    .filter((s) => s.strategy !== 'baseline_current')
    .sort((a, b) => {
      if (a.total_replay_rows !== b.total_replay_rows) return a.total_replay_rows - b.total_replay_rows;
      return b.promoted_pass_rows - a.promoted_pass_rows;
    });
  const recommended = ranked[0] || null;

  const out = {
    generatedAt: new Date().toISOString(),
    dataRoot: root,
    baseline_state: {
      promoted_in_signals_count: new Set(
        signals
          .filter((s) => promotedKeySet.has(String(s.setupId || s.strategyId || '').trim()))
          .map((s) => String(s.setupId || s.strategyId || '').trim())
      ).size,
      promoted_and_paper_recent:
        Array.isArray(strictMapping.promoted_and_paper_recent) ? strictMapping.promoted_and_paper_recent.length : null,
      duplicate_throttle_keys_count: Object.keys(seenKeys).length,
      signal_rows_total: signals.length,
      promoted_signal_rows_total: signals.filter((s) => promotedKeySet.has(String(s.setupId || s.strategyId || '').trim())).length,
    },
    sandbox_strategies: strategySummaries,
    recommended_min_noise_strategy: recommended,
    notes: [
      'Sandbox only: no runtime behavior changed.',
      'Replay rows = rows that are currently seen-key blocked but would become passable under a strategy.',
    ],
  };

  const outPath = path.join(gov, 'persistent_throttle_renewal_sandbox_audit.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, outPath, recommended }, null, 2));
}

if (require.main === module) main();
