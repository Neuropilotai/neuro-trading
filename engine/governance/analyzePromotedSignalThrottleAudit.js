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

function pkey(sig, datasets) {
  const dk = sig.datasetKey != null ? String(sig.datasetKey).trim() : '';
  const sid = String(sig.strategyId || sig.setupId || '').trim();
  const ds = datasets[String(sig.datasetKey || '')] || {};
  const sym = String(sig.symbol || ds.symbol || '').toUpperCase().trim();
  const tf = String(sig.timeframe || ds.timeframe || '').trim();
  const bi = Number(sig.barIndex);
  const barPart = Number.isFinite(bi) ? String(Math.floor(bi)) : 'na';
  return `${dk || 'na'}|${sid}|${sym}|${tf}|${barPart}`;
}

function main() {
  const root = dataRoot.getDataRoot();
  const gov = path.join(root, 'governance');
  const signals = safeReadJson(path.join(gov, 'paper_execution_v1_signals.json'));
  const seen = safeReadJson(path.join(gov, 'paper_exec_seen_keys.json'));
  const manifest = safeReadJson(path.join(root, 'datasets_manifest.json'));
  const lastRun = safeReadJson(path.join(gov, 'paper_exec_v1_last_run.json'));

  const ds = manifest && manifest.datasets ? manifest.datasets : {};
  const sigs = Array.isArray(signals && signals.signals) ? signals.signals : [];
  const promoted = sigs.filter((s) => s && s.signalSource === 'promoted_manifest');
  const keys = seen && seen.keys ? seen.keys : {};

  const blocked = [];
  const unblocked = [];
  const bySetup = {};
  for (const s of promoted) {
    const key = pkey(s, ds);
    const setupKey = String(s.setupId || s.strategyId || '').trim();
    const row = {
      setupKey,
      strategyId: String(s.strategyId || ''),
      setupId: String(s.setupId || ''),
      datasetKey: String(s.datasetKey || ''),
      symbol: String(s.symbol || ds[String(s.datasetKey || '')]?.symbol || ''),
      timeframe: String(s.timeframe || ds[String(s.datasetKey || '')]?.timeframe || ''),
      barIndex: Number(s.barIndex),
      persistentKey: key,
    };
    if (keys[key]) {
      row.firstSeenAt = keys[key].firstSeenAt || null;
      blocked.push(row);
    } else {
      unblocked.push(row);
    }
    if (!bySetup[setupKey]) bySetup[setupKey] = { total: 0, blocked: 0, unblocked: 0 };
    bySetup[setupKey].total += 1;
    if (keys[key]) bySetup[setupKey].blocked += 1;
    else bySetup[setupKey].unblocked += 1;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    promoted_signal_rows_total: promoted.length,
    promoted_signal_rows_seen_in_persistent_store: blocked.length,
    promoted_signal_rows_not_seen_in_persistent_store: unblocked.length,
    throttle_is_primary_blocker: promoted.length > 0 && blocked.length === promoted.length,
    appended_last_run: Number(lastRun && lastRun.effectiveAppended || 0),
    duplicateSkippedPersistent_last_run: Number(lastRun && lastRun.duplicateSkippedPersistent || 0),
    promoted_setups_breakdown: bySetup,
    blocked_sample: blocked.slice(0, 20),
    unblocked_sample: unblocked.slice(0, 20),
  };

  const outPath = path.join(gov, 'promoted_signal_throttle_audit.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, outPath, summary: {
    promoted_signal_rows_total: out.promoted_signal_rows_total,
    promoted_signal_rows_seen_in_persistent_store: out.promoted_signal_rows_seen_in_persistent_store,
    promoted_signal_rows_not_seen_in_persistent_store: out.promoted_signal_rows_not_seen_in_persistent_store,
    throttle_is_primary_blocker: out.throttle_is_primary_blocker
  }}, null, 2));
}

if (require.main === module) main();
