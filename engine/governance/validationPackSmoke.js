#!/usr/bin/env node
'use strict';

/**
 * Validation pack — Pass 1 (smoke fonctionnel).
 *
 * - Vérifie les artefacts discovery attendus sous NEUROPILOT_DATA_ROOT (sauf --skip-workspace-checks).
 * - Lance exportOpsSnapshot.js et vérifie governance_dashboard + autres JSON ops.
 * - Enchaîne les smokes isolés : P6 governor, P7 run_trend_memory, P7.1 trendMemoryApply.
 *
 * Usage (depuis neuropilot_trading_v2):
 *   node engine/governance/validationPackSmoke.js
 *   node engine/governance/validationPackSmoke.js --skip-workspace-checks
 *
 * Exit: 0 = OK, 1 = échec (message sur stderr).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dataRoot = require('../dataRoot');

const V2_ROOT = path.resolve(__dirname, '..', '..');
const args = new Set(process.argv.slice(2));
const skipWorkspace = args.has('--skip-workspace-checks');

function fail(msg) {
  console.error('[validation-pack]', msg);
  process.exit(1);
}

function ok(msg) {
  console.log('[validation-pack]', msg);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function assertFileJson(label, filePath, minKeys = []) {
  if (!fs.existsSync(filePath)) {
    fail(`${label}: fichier manquant: ${filePath}`);
  }
  const st = fs.statSync(filePath);
  if (!st.size) {
    fail(`${label}: fichier vide: ${filePath}`);
  }
  const j = readJson(filePath);
  if (!j || typeof j !== 'object') {
    fail(`${label}: JSON invalide: ${filePath}`);
  }
  for (const k of minKeys) {
    if (!(k in j)) {
      fail(`${label}: clé manquante "${k}" dans ${filePath}`);
    }
  }
  return j;
}

function runNode(relScript, description) {
  const scriptPath = path.join(V2_ROOT, relScript);
  if (!fs.existsSync(scriptPath)) {
    fail(`Script introuvable: ${scriptPath}`);
  }
  ok(`run: ${description}`);
  const r = spawnSync(process.execPath, [scriptPath], {
    cwd: V2_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (r.status !== 0) {
    console.error(r.stdout || '');
    console.error(r.stderr || '');
    fail(`${description} → exit ${r.status}`);
  }
  if (r.stdout && r.stdout.trim()) {
    console.log(r.stdout.trimEnd());
  }
}

function checkWorkspaceArtifacts() {
  const root = dataRoot.getDataRoot();
  const discovery = path.join(root, 'discovery');
  ok(`dataRoot: ${root}`);

  const checks = [
    {
      rel: 'governance_mini_report.json',
      keys: ['experimentId', 'governanceStatus'],
    },
    {
      rel: 'run_trend_memory.json',
      keys: ['trendMemoryVersion'],
    },
    {
      rel: 'portfolio_governor.json',
      keys: ['governanceStatus', 'experimentId'],
    },
    {
      rel: 'mutation_policy.json',
      keys: ['experimentId'],
    },
  ];

  for (const c of checks) {
    const p = path.join(discovery, c.rel);
    assertFileJson(c.rel, p, c.keys);
    ok(`  OK ${c.rel}`);
  }

  checkCycleIdAlignment(discovery);
}

/**
 * Same-run alignment: governor / policy / P7 trend are produced under the same EXPERIMENT_ID.
 * Does not compare governance_mini_report (Option A: prior cycle until mini is regenerated).
 */
function checkCycleIdAlignment(discovery) {
  const gov = readJson(path.join(discovery, 'portfolio_governor.json'));
  const pol = readJson(path.join(discovery, 'mutation_policy.json'));
  const tm = readJson(path.join(discovery, 'run_trend_memory.json'));
  const g = gov && typeof gov.cycleId === 'string' && gov.cycleId ? gov.cycleId : null;
  const p = pol && typeof pol.cycleId === 'string' && pol.cycleId ? pol.cycleId : null;
  const t = tm && typeof tm.producingCycleId === 'string' && tm.producingCycleId ? tm.producingCycleId : null;
  const present = [g, p, t].filter(Boolean);
  if (present.length < 2) {
    ok('  cycleId alignment: skipped (governor/policy/trend — champs cycle partiels, legacy OK)');
    return;
  }
  const uniq = new Set(present);
  if (uniq.size > 1) {
    fail(
      `cycleId désaligné (governor/policy/trend): governor=${g || 'n/a'} policy=${p || 'n/a'} producingCycleId=${t || 'n/a'}`
    );
  }
  ok(`  cycleId alignment: OK (${[...uniq][0]})`);
}

function checkOpsSnapshot() {
  const snap = path.join(V2_ROOT, 'ops-snapshot');
  const files = [
    'latest.json',
    'governance_dashboard.json',
    'governance_dashboard.html',
  ];
  for (const f of files) {
    const p = path.join(snap, f);
    if (!fs.existsSync(p) || !fs.statSync(p).size) {
      fail(`ops-snapshot manquant ou vide: ${p}`);
    }
  }
  const dash = readJson(path.join(snap, 'governance_dashboard.json'));
  if (!dash || typeof dash !== 'object') {
    fail('governance_dashboard.json illisible');
  }
  if (!dash.dashboardVersion || !dash.lastRun || !dash.sources) {
    fail('governance_dashboard.json: structure attendue (dashboardVersion, lastRun, sources)');
  }
  ok(`  OK ops-snapshot/ (${files.join(', ')})`);
  ok(`  dashboardVersion=${dash.dashboardVersion}`);
}

function main() {
  ok('=== Pass 1 — Validation pack (smoke) ===');

  if (!skipWorkspace) {
    ok('-- Workspace discovery artefacts --');
    checkWorkspaceArtifacts();
  } else {
    ok('--skip-workspace-checks: saut des fichiers discovery (dataRoot=' + dataRoot.getDataRoot() + ')');
  }

  ok('-- exportOpsSnapshot + P8.1 dashboard --');
  runNode('engine/evolution/scripts/exportOpsSnapshot.js', 'exportOpsSnapshot.js');
  checkOpsSnapshot();

  ok('-- Smokes isolés (tmp, pas de mutation data_root requise) --');
  runNode('engine/scripts/smokePortfolioGovernor.js', 'smokePortfolioGovernor.js (nominal / degraded / blocked)');
  runNode('engine/scripts/smokeRunTrendMemory.js', 'smokeRunTrendMemory.js (P7)');
  runNode('engine/scripts/smokeTrendMemoryApply.js', 'smokeTrendMemoryApply.js (P7.1 conservative + mutations off/on)');

  ok('=== Pass 1 terminé: OK ===');
}

main();
